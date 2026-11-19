import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from muse_bridge.client import BridgeClient, BridgeError


def configuration(revision=1, ids=("research",)):
    skills = []
    for skill_id in ids:
        content = f"# {skill_id}\nRevision {revision}\n"
        skills.append({"source": "bundled", "id": skill_id, "version": "1.0.0", "name": skill_id, "content": content, "sha256": hashlib.sha256(content.encode()).hexdigest()})
    return {"revision": revision, "role": {"name": "Reviewer", "prompt": "Review sources.", "summary": "Reviewer"}, "role_prompt": "Review sources.\n\nStay in scope.", "role_summary": "Reviewer", "instructions": "Stay in scope.", "permissions": {"file_read": True, "external_send": False}, "allowed_actions": ["file_read"], "skills": skills}


class ConfigurationSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="muse-python-sync-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "manual").mkdir()
        (self.root / "manual" / "SKILL.md").write_text("# Hand-written\n")
        self.client = BridgeClient("https://muse.example", agent_key="fixture-key", skills_directory=str(self.root))
        self.config = configuration()
        self.hint = 1
        self.calls = []
        self.fail_staged = False
        self.fail_applied = False
        self.request_patch = patch.object(self.client, "_request", side_effect=self.request)
        self.request_patch.start()
        self.addCleanup(self.request_patch.stop)

    def request(self, path, *, method="GET", payload=None, **kwargs):
        self.calls.append((path, payload))
        if path == "/api/agents/heartbeat":
            return {"ok": True, **({"configuration": {"revision": self.hint}} if self.hint else {})}
        if path == "/api/agents/me/configuration":
            return {"configuration": self.config} if self.config else None
        if path.endswith("/ack"):
            if (payload["status"] == "staged" and self.fail_staged) or (payload["status"] == "applied" and self.fail_applied):
                raise BridgeError("Retry later", status=409)
            return {"ok": True, "status": payload["status"]}
        raise AssertionError(path)

    def acks(self):
        return [payload["status"] for path, payload in self.calls if path.endswith("/ack")]

    def current(self):
        namespaces = [p for p in (self.root / "muse-managed").iterdir() if len(p.name) == 64]
        self.assertEqual(len(namespaces), 1)
        link = namespaces[0] / "current"
        self.assertTrue(link.is_symlink())
        snapshot = link.resolve()
        self.assertEqual(snapshot.parent, namespaces[0])
        return snapshot, json.loads((snapshot / "configuration.json").read_text())

    def test_unconfigured_and_legacy_leave_disk_untouched(self):
        self.hint = 0
        self.config = None
        self.assertEqual(self.client.heartbeat(), {"ok": True})
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.client.sync_configuration()["status"], "unconfigured")
        self.assertEqual([p.name for p in self.root.iterdir()], ["manual"])

    def test_startup_installs_role_actions_and_skills_then_acks(self):
        self.assertEqual(self.client.sync_configuration()["status"], "applied")
        self.assertEqual(self.acks(), ["staged", "applied"])
        snapshot, installed = self.current()
        self.assertEqual((snapshot / "bundled-research" / "SKILL.md").read_text(), self.config["skills"][0]["content"])
        self.assertEqual(installed["role_prompt"], self.config["role_prompt"])
        self.assertEqual(installed["allowed_actions"], ["file_read"])
        self.assertEqual((self.root / "manual" / "SKILL.md").read_text(), "# Hand-written\n")

    def test_revision_change_removes_skills_from_current_only(self):
        self.client.heartbeat()
        first, _ = self.current()
        count = len(self.calls)
        self.client.heartbeat()
        self.assertEqual(len(self.calls), count + 1)
        self.hint = 2
        self.config = configuration(2, ("debug",))
        self.client.heartbeat()
        second, _ = self.current()
        self.assertNotEqual(first, second)
        self.assertEqual(sorted(p.name for p in second.iterdir()), ["bundled-debug", "configuration.json"])
        self.assertTrue((first / "bundled-research" / "SKILL.md").exists())
        self.assertEqual((self.root / "manual" / "SKILL.md").read_text(), "# Hand-written\n")

    def test_invalid_hash_traversal_duplicate_and_unknown_actions_do_not_write(self):
        for kind in ("hash", "path", "duplicate", "action"):
            self.config = configuration()
            if kind == "hash": self.config["skills"][0]["sha256"] = "0" * 64
            if kind == "path": self.config["skills"][0]["id"] = "../../outside"
            if kind == "duplicate": self.config["skills"].append(self.config["skills"][0])
            if kind == "action": self.config["allowed_actions"].append("unknown_grant")
            self.client.heartbeat()
            self.assertEqual(self.acks()[-1], "failed")
            self.assertEqual([p.name for p in self.root.iterdir()], ["manual"])

    def test_staged_failure_keeps_prior_snapshot(self):
        self.client.heartbeat()
        first, _ = self.current()
        self.hint = 2
        self.config = configuration(2)
        self.fail_staged = True
        self.client.heartbeat()
        self.assertEqual(self.current()[0], first)
        self.assertEqual(self.acks()[-1], "failed")

    def test_applied_ack_retry_does_not_rewrite_or_report_failed(self):
        self.fail_applied = True
        self.client.heartbeat()
        first, _ = self.current()
        self.fail_applied = False
        self.client.heartbeat()
        self.assertEqual(self.current()[0], first)
        self.assertEqual(self.acks(), ["staged", "applied", "applied"])
        self.assertEqual(sum(path == "/api/agents/me/configuration" for path, _ in self.calls), 1)

    def test_manual_managed_root_is_not_adopted(self):
        managed = self.root / "muse-managed"
        managed.mkdir()
        (managed / "manual.txt").write_text("keep")
        self.client.heartbeat()
        self.assertEqual(self.acks(), ["failed"])
        self.assertEqual((managed / "manual.txt").read_text(), "keep")

    def test_symlinked_skills_root_is_rejected(self):
        target = self.root / "target"
        target.mkdir()
        link = self.root / "linked"
        link.symlink_to(target, target_is_directory=True)
        linked = BridgeClient("https://muse.example", agent_key="fixture-key", skills_directory=str(link))
        with patch.object(linked, "_request", side_effect=self.request):
            self.assertEqual(linked.sync_configuration()["status"], "failed")
        self.assertEqual(list(target.iterdir()), [])

    def test_restart_reuses_a_verified_snapshot(self):
        self.client.heartbeat()
        first, _ = self.current()
        restarted = BridgeClient("https://muse.example", agent_key="fixture-key", skills_directory=str(self.root))
        with patch.object(restarted, "_request", side_effect=self.request):
            self.assertEqual(restarted.sync_configuration()["status"], "applied")
        self.assertEqual(self.current()[0], first)

    def test_older_hub_404_is_unconfigured(self):
        with patch.object(self.client, "_request", side_effect=BridgeError("Missing", status=404)):
            self.assertEqual(self.client.sync_configuration()["status"], "unconfigured")
        self.assertEqual([p.name for p in self.root.iterdir()], ["manual"])


if __name__ == "__main__": unittest.main()
