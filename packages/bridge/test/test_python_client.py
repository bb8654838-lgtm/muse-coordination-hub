from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_ROOT / "python"))

from muse_bridge.client import BridgeClient  # noqa: E402


class RecordingTransport:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def __call__(self, method: str, url: str, headers: dict, payload: dict | None):
        self.calls.append(
            {"method": method, "url": url, "headers": headers, "payload": payload}
        )
        return {"ok": True}


class PythonBridgeClientTests(unittest.TestCase):
    def test_registration_preserves_custom_identity(self) -> None:
        transport = RecordingTransport()
        client = BridgeClient("https://hub.example", transport=transport)
        client.register(
            workspace_id="workspace-id",
            invite_key="invite-key",
            display_name="Custom Name",
            role="Custom Role",
        )
        self.assertEqual(
            transport.calls[0]["payload"],
            {
                "workspace_id": "workspace-id",
                "invite_key": "invite-key",
                "display_name": "Custom Name",
                "role": "Custom Role",
            },
        )

    def test_authenticated_task_lifecycle(self) -> None:
        transport = RecordingTransport()
        client = BridgeClient(
            "https://hub.example/", agent_key="agent-secret", transport=transport
        )
        client.heartbeat(status="online")
        client.inbox(limit=25)
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "result.txt"
            artifact.write_text("result", encoding="utf-8")
            client.upload_file(artifact, task_id="task-id")
        client.ack_task("task-id")
        client.complete_task("task-id", result_link="https://result.example/item")

        self.assertEqual(
            [call["url"].split("https://hub.example", 1)[1].split("?", 1)[0] for call in transport.calls],
            [
                "/api/agents/heartbeat",
                "/api/inbox",
                "/api/files",
                "/api/tasks/task-id/ack",
                "/api/tasks/task-id/complete",
            ],
        )
        self.assertEqual(
            transport.calls[2]["payload"],
            {
                "name": "result.txt",
                "content_base64": "cmVzdWx0",
                "content_type": "text/plain",
                "task_id": "task-id",
            },
        )
        for call in transport.calls:
            self.assertEqual(call["headers"]["Authorization"], "Bearer agent-secret")


if __name__ == "__main__":
    unittest.main()
