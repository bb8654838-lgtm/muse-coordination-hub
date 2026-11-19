from __future__ import annotations

import base64
import json
import mimetypes
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from .configuration import ConfigurationSync

Transport = Callable[[str, str, dict[str, str], dict[str, Any] | None], dict[str, Any]]


class BridgeError(RuntimeError):
    """A hub request failed or returned an error response."""

    def __init__(self, message: str, *, status: int = 0, payload: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.payload = payload


def _default_transport(
    method: str,
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any] | None,
) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            details = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            details = {"raw": raw}
        message = (
            details.get("error", {}).get("message")
            if isinstance(details, dict)
            else None
        ) or f"Hub returned HTTP {error.code}"
        raise BridgeError(message, status=error.code, payload=details) from error
    except urllib.error.URLError as error:
        raise BridgeError(f"Hub request failed: {error.reason}") from error


class BridgeClient:
    def __init__(
        self,
        base_url: str,
        *,
        agent_key: str | None = None,
        transport: Transport | None = None,
        skills_directory: str | Path | None = None,
    ) -> None:
        if not base_url:
            raise ValueError("base_url is required")
        self.base_url = base_url.rstrip("/")
        self.agent_key = agent_key
        self.transport = transport or _default_transport
        self._configuration_sync = ConfigurationSync(lambda path, **options: self._request(path, **options), self.base_url, self.agent_key, skills_directory)

    def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        payload: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        authenticated: bool = True,
    ) -> dict[str, Any]:
        if authenticated and not self.agent_key:
            raise BridgeError("MUSE_AGENT_KEY is required for this operation")
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
        headers = {"Accept": "application/json"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if authenticated:
            headers["Authorization"] = f"Bearer {self.agent_key}"
        return self.transport(method, url, headers, payload)

    def register(
        self,
        *,
        workspace_id: str,
        invite_key: str,
        display_name: str,
        role: str,
    ) -> dict[str, Any]:
        result = self._request(
            "/api/agents/register",
            method="POST",
            authenticated=False,
            payload={
                "workspace_id": workspace_id,
                "invite_key": invite_key,
                "display_name": display_name,
                "role": role,
            },
        )
        if result.get("agent_key"):
            self.agent_key = result["agent_key"]
            self._configuration_sync = ConfigurationSync(self._request, self.base_url, self.agent_key, self._configuration_sync.root)
            self.sync_configuration()
        return result

    def sync_configuration(self) -> dict[str, Any]:
        return self._configuration_sync.sync()

    def heartbeat(
        self, *, status: str = "online", metadata: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        result = self._request(
            "/api/agents/heartbeat",
            method="POST",
            payload={"status": status, "metadata": metadata or {}},
        )
        configuration = result.get("configuration")
        if isinstance(configuration, dict) and type(configuration.get("revision")) is int and configuration["revision"] > 0:
            self._configuration_sync.sync(configuration["revision"])
        return result

    def inbox(self, *, limit: int = 50) -> dict[str, Any]:
        return self._request("/api/inbox", query={"limit": max(1, min(100, int(limit)))})

    def send_message(
        self,
        *,
        channel_id: str,
        body: str,
        message_type: str = "NOTE",
        mentions: list[str] | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "/api/messages",
            method="POST",
            payload={
                "channel_id": channel_id,
                "body": body,
                "type": message_type,
                "mentions": mentions or [],
                "reply_to": reply_to,
                "metadata": metadata or {},
            },
        )

    def upload_file(
        self,
        file_path: str | Path,
        *,
        task_id: str | None = None,
        content_type: str | None = None,
    ) -> dict[str, Any]:
        path = Path(file_path)
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        detected_type = content_type or mimetypes.guess_type(path.name)[0]
        return self._request(
            "/api/files",
            method="POST",
            payload={
                "name": path.name,
                "content_base64": encoded,
                "content_type": detected_type or "application/octet-stream",
                "task_id": task_id,
            },
        )

    def ack_task(self, task_id: str) -> dict[str, Any]:
        return self._request(f"/api/tasks/{urllib.parse.quote(task_id, safe='')}/ack", method="POST")

    def complete_task(
        self, task_id: str, *, result_link: str | None = None
    ) -> dict[str, Any]:
        return self._request(
            f"/api/tasks/{urllib.parse.quote(task_id, safe='')}/complete",
            method="POST",
            payload={"result_link": result_link},
        )

    def poll_inbox(
        self, *, limit: int = 50, interval_seconds: int = 60
    ) -> Iterator[dict[str, Any]]:
        interval = max(5, int(interval_seconds))
        while True:
            yield self.inbox(limit=limit)
            time.sleep(interval)
