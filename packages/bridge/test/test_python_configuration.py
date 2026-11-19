from __future__ import annotations
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from muse_bridge.client import BridgeClient, BridgeError

CONTENT = "# Review\r\nKeep byte identity — evidence first.\n"
def bundle(revision=1, with_skills=True):
    return {"revision": revision, "role": None, "role_prompt": "Review carefully.", "role_summary": "Reviewer", "instructions": "Review carefully.",
            "permissions": {"file_read": True, "file_write": False}, "allowed_actions": ["file_read"],
            "skills": [{"source": "bundled", "id": "review", "version": "1.0.0", "name": "Review", "content": CONTENT, "sha256": hashlib.sha256(CONTENT.encode()).hexdigest()}] if with_skills else []}

class FixtureClient(BridgeClient):
    def __init__(self, root, config=None):
        super().__init__("https://hub.example", agent_key="fixture-token", skills_directory=str(root))
        self.configuration = config
        self.acks, self.pulls = [], 0
        self.fail_applied = False
        self.fail_pull = False
        self.legacy = False
        self.staged_status = 200
    def _request(self, path, method="GET", payload=None, query=None, authenticated=True):
        if path == "/api/agents/heartbeat":
            return {"ok": True, **({"configuration": {"revision": self.configuration["revision"]}} if self.configuration else {})}
        if path == "/api/agents/register":
            return {"agent_key": "fixture-token", "agent": {"id": "fixture"}}
        if path == "/api/agents/me/configuration":
            self.pulls += 1
            if self.legacy:
                raise BridgeError("not_found", status=404)
            if self.fail_pull:
                raise RuntimeError("fixture-only-raw-error-do-not-transmit")
            return {"configuration": self.configuration} if self.configuration else {}
        if path.endswith("/ack"):
            self.acks.append(dict(payload))
            if payload["status"] == "staged" and self.staged_status != 200:
                raise BridgeError("revision_conflict", status=self.staged_status)
            if payload["status"] == "applied" and self.fail_applied:
                raise BridgeError("retry", status=503)
            return {"ok": True}
        raise AssertionError("Unexpected fixture request")

def namespace(root):
    return next(item for item in (root / "muse-managed").iterdir() if item.is_dir())

def fresh():
    # Kept under the test run's explicit TMPDIR; no operator skill paths are used.
    return Path(tempfile.mkdtemp(prefix="muse-python-sync-"))

class ConfigurationTests(unittest.TestCase):
    def test_startup_heartbeat_restart_and_manual_preservation(self):
        root = fresh(); (root / "manual").mkdir(); (root / "manual" / "SKILL.md").write_bytes(b"# Human-owned\n")
        client = FixtureClient(root, bundle())
        self.assertEqual(client.sync_configuration()["status"], "applied")
        managed = namespace(root); first = os.readlink(managed / "current")
        self.assertEqual((managed / "current" / "bundled-review" / "SKILL.md").read_bytes(), CONTENT.encode())
        self.assertEqual([ack["status"] for ack in client.acks], ["staged", "applied"])
        client.heartbeat(); self.assertEqual(client.pulls, 1)
        client.configuration = bundle(2, False); client.heartbeat()
        second = os.readlink(managed / "current"); self.assertNotEqual(first, second)
        self.assertEqual(json.loads((managed / "current" / "configuration.json").read_text())["revision"], 2)
        self.assertFalse((managed / "current" / "bundled-review").exists())
        self.assertEqual((managed / first / "bundled-review" / "SKILL.md").read_bytes(), CONTENT.encode())
        self.assertEqual((root / "manual" / "SKILL.md").read_bytes(), b"# Human-owned\n")
        restart = FixtureClient(root, bundle(2, False)); restart.sync_configuration()
        self.assertEqual(os.readlink(managed / "current"), second)
        self.assertEqual([ack["status"] for ack in restart.acks], ["applied"])

    def test_neutral_and_legacy_do_not_touch_files(self):
        parent = fresh(); root = parent / "untouched"; client = FixtureClient(root)
        client.heartbeat(); self.assertEqual(client.pulls, 0)
        self.assertEqual(client.sync_configuration()["status"], "unconfigured")
        self.assertEqual(list(parent.iterdir()), []); self.assertEqual(client.acks, [])
        client.legacy = True; self.assertEqual(client.sync_configuration()["status"], "unconfigured")
        self.assertEqual(list(parent.iterdir()), [])

    def test_retry_ack_and_detect_modified_skill(self):
        root = fresh(); client = FixtureClient(root, bundle()); client.fail_applied = True
        self.assertEqual(client.sync_configuration(), {"revision": 1, "status": "applied", "acknowledged": False})
        managed = namespace(root); before = os.readlink(managed / "current")
        client.fail_applied = False; client.heartbeat()
        self.assertEqual(os.readlink(managed / "current"), before)
        self.assertEqual([ack["status"] for ack in client.acks], ["staged", "applied", "applied"])
        (managed / "current" / "bundled-review" / "SKILL.md").write_bytes(b"# Local modification")
        client.configuration = bundle(2)
        self.assertEqual(client.sync_configuration()["status"], "failed")
        self.assertEqual(os.readlink(managed / "current"), before)
        self.assertEqual(client.acks[-1]["status"], "failed")
        self.assertEqual((managed / "current" / "bundled-review" / "SKILL.md").read_bytes(), b"# Local modification")

    def test_invalid_checksum_and_traversal_are_rejected_without_io(self):
        for field, value in [("sha256", "0" * 64), ("id", "../escape")]:
            parent = fresh(); config = bundle(); config["skills"][0][field] = value
            client = FixtureClient(parent / "untouched", config)
            self.assertEqual(client.sync_configuration()["status"], "failed")
            self.assertEqual(list(parent.iterdir()), [])
            self.assertEqual(client.acks[-1]["status"], "failed")
            self.assertNotIn("escape", client.acks[-1]["error"])
        config = bundle(); config["allowed_actions"].append("deploy"); parent = fresh()
        self.assertEqual(FixtureClient(parent / "untouched", config).sync_configuration()["status"], "failed")
        self.assertEqual(list(parent.iterdir()), [])

    def test_unowned_and_symlink_directories_preserved(self):
        root = fresh(); managed = root / "muse-managed"; managed.mkdir(); (managed / "manual.txt").write_bytes(b"manual")
        self.assertEqual(FixtureClient(root, bundle()).sync_configuration()["status"], "failed")
        self.assertEqual((managed / "manual.txt").read_bytes(), b"manual")
        parent = fresh(); target = parent / "target"; target.mkdir(); linked = parent / "linked"; linked.symlink_to(target, target_is_directory=True)
        self.assertEqual(FixtureClient(linked, bundle()).sync_configuration()["status"], "failed")
        self.assertEqual(list(target.iterdir()), [])

    def test_staged_conflict_and_fetch_failure(self):
        root = fresh(); client = FixtureClient(root, bundle()); client.sync_configuration()
        managed = namespace(root); before = os.readlink(managed / "current")
        client.configuration = bundle(2); client.staged_status = 409
        self.assertEqual(client.sync_configuration()["status"], "failed")
        self.assertEqual(os.readlink(managed / "current"), before)
        client.staged_status = 200; client.heartbeat(); self.assertNotEqual(os.readlink(managed / "current"), before)
        client.fail_pull = True; count = len(client.acks)
        self.assertEqual(client.sync_configuration()["status"], "failed"); self.assertEqual(len(client.acks), count)

    def test_registration_sync(self):
        client = FixtureClient(fresh(), bundle())
        client.register(workspace_id="fixture", invite_key="fixture", display_name="Fixture", role="review")
        self.assertEqual(client.pulls, 1)
        self.assertEqual([ack["status"] for ack in client.acks], ["staged", "applied"])

if __name__ == "__main__":
    unittest.main()
