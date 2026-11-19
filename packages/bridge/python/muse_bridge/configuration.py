"""Hub-owned, immutable skill snapshots with an atomic current pointer.

The containing skills directory is never scanned or changed for neutral agents.
Only a marked muse-managed namespace belongs to this synchronizer.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any, Callable

ACTIONS = ("file_read", "file_write", "code_execute", "network_read", "external_send", "deploy", "delegate", "financial_action")
FORMAT = "muse-managed-skills-v1"
MARKER = ".muse-skill-sync.json"
FAILED = "Managed configuration sync failed. Check bundle integrity, directory ownership and filesystem permissions."


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _integer(value: Any) -> bool:
    return type(value) is int and 0 < value <= 2147483647


def _validate(config: Any) -> dict[str, Any]:
    if not isinstance(config, dict) or not _integer(config.get("revision")) or not isinstance(config.get("skills"), list) or len(config["skills"]) > 64 or len(json.dumps(config, ensure_ascii=False).encode()) > 32_000_000:
        raise ValueError("Invalid configuration")
    for field in ("role_prompt", "role_summary", "instructions"):
        if not isinstance(config.get(field), str) or "\0" in config[field]:
            raise ValueError("Invalid role content")
    role = config.get("role")
    if role is not None and (not isinstance(role, dict) or any(not isinstance(role.get(key), str) for key in ("name", "prompt", "summary"))):
        raise ValueError("Invalid role")
    permissions = config.get("permissions")
    if not isinstance(permissions, dict) or any(key not in ACTIONS or type(value) is not bool for key, value in permissions.items()):
        raise ValueError("Invalid permissions")
    actions = config.get("allowed_actions")
    if not isinstance(actions, list) or any(not isinstance(key, str) for key in actions) or len(set(actions)) != len(actions) or any(key not in ACTIONS or permissions.get(key) is not True for key in actions) or any(value is True and key not in actions for key, value in permissions.items()):
        raise ValueError("Invalid allowed actions")
    seen = set()
    for skill in config["skills"]:
        if not isinstance(skill, dict) or skill.get("source") not in ("bundled", "custom") or not isinstance(skill.get("id"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", skill["id"]) or not isinstance(skill.get("name"), str):
            raise ValueError("Invalid skill identity")
        version = skill.get("version")
        if not (_integer(version) if skill["source"] == "custom" else isinstance(version, str) and version):
            raise ValueError("Invalid skill version")
        key = f"{skill['source']}-{skill['id']}"
        content, digest = skill.get("content"), skill.get("sha256")
        if key in seen or not isinstance(content, str) or "\0" in content or len(content.encode("utf-16-le")) // 2 > 100_000 or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest) or _hash(content) != digest:
            raise ValueError("Invalid skill content")
        seen.add(key)
    return config


def _safe_directory(directory: Path) -> None:
    for part in reversed((directory, *directory.parents)):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if part.is_symlink() or not part.is_dir():
            raise ValueError("Unsafe directory")


def _regular_file(filename: Path) -> str:
    if filename.is_symlink() or not filename.is_file():
        raise ValueError("Unsafe managed file")
    with filename.open("r", encoding="utf-8", newline="") as source:
        return source.read()


def _write(filename: Path, value: str) -> None:
    descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as output:
        output.write(value)
        output.flush()
        os.fsync(output.fileno())


def _owned_directory(directory: Path, scope: str | None = None) -> None:
    _safe_directory(directory)
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        marker = json.loads(_regular_file(directory / MARKER))
        if marker.get("format") != FORMAT or marker.get("scope") != scope:
            raise ValueError("Unowned managed directory")
    else:
        _write(directory / MARKER, json.dumps({"format": FORMAT, "scope": scope}))


def _current(namespace: Path) -> dict[str, Any] | None:
    current = namespace / "current"
    try:
        current.lstat()
    except FileNotFoundError:
        return None
    if not current.is_symlink():
        raise ValueError("Unowned current pointer")
    target = os.readlink(current)
    if not re.fullmatch(r"revision-[1-9][0-9]*-[a-f0-9-]+", target):
        raise ValueError("Unsafe current pointer")
    snapshot = namespace / target
    _safe_directory(snapshot)
    config = _validate(json.loads(_regular_file(snapshot / "configuration.json")))
    if not target.startswith(f"revision-{config['revision']}-"):
        raise ValueError("Revision mismatch")
    for skill in config["skills"]:
        directory = snapshot / f"{skill['source']}-{skill['id']}"
        _safe_directory(directory)
        if _hash(_regular_file(directory / "SKILL.md")) != skill["sha256"]:
            raise ValueError("Modified managed skill")
    return config


class ConfigurationSync:
    def __init__(self, request: Callable[..., Any], base_url: str, agent_key: str | None, skills_directory: str | Path | None):
        self.request = request
        self.root = Path(os.path.abspath(skills_directory or Path.cwd() / "skills"))
        self.scope = _hash(f"{base_url}\0{agent_key or ''}")
        self.applied_revision = 0
        self.acked_revision = 0
        self.lock = threading.Lock()

    def _ack(self, revision: int, status: str, error: str | None = None) -> Any:
        payload = {"revision": revision, "status": status}
        if error:
            payload["error"] = error
        return self.request("/api/agents/me/configuration/ack", method="POST", payload=payload)

    def _finish(self, revision: int) -> dict[str, Any]:
        try:
            self._ack(revision, "applied")
            self.acked_revision = revision
            return {"revision": revision, "status": "applied", "acknowledged": True}
        except Exception:
            return {"revision": revision, "status": "applied", "acknowledged": False}

    def sync(self, hint: int | None = None) -> dict[str, Any]:
        with self.lock:
            if _integer(hint) and self.acked_revision == hint:
                return {"revision": hint, "status": "applied", "acknowledged": True}
            if _integer(hint) and self.applied_revision == hint:
                return self._finish(hint)
            revision = hint if _integer(hint) else None
            lock = None
            try:
                try:
                    payload = self.request("/api/agents/me/configuration")
                except Exception as error:
                    if getattr(error, "status", 0) in (404, 204):
                        return {"status": "unconfigured"}
                    raise
                if not isinstance(payload, dict) or not payload.get("configuration"):
                    return {"status": "unconfigured"}
                candidate = payload["configuration"]
                if isinstance(candidate, dict) and _integer(candidate.get("revision")):
                    revision = candidate["revision"]
                config = _validate(candidate)
                revision = config["revision"]
                _safe_directory(self.root)
                self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
                managed = self.root / "muse-managed"
                _owned_directory(managed)
                namespace = managed / self.scope
                _owned_directory(namespace, self.scope)
                lock_path = namespace / ".sync-lock"
                lock_path.mkdir(mode=0o700)
                lock = lock_path
                existing = _current(namespace)
                if existing and existing["revision"] > revision:
                    raise ValueError("Refusing revision downgrade")
                if existing == config:
                    self.applied_revision = revision
                    return self._finish(revision)
                generation = f"revision-{revision}-{uuid.uuid4()}"
                snapshot = namespace / generation
                snapshot.mkdir(mode=0o700)
                for skill in config["skills"]:
                    directory = snapshot / f"{skill['source']}-{skill['id']}"
                    directory.mkdir(mode=0o700)
                    _write(directory / "SKILL.md", skill["content"])
                _write(snapshot / "configuration.json", json.dumps(config, ensure_ascii=False, indent=2) + "\n")
                self._ack(revision, "staged")
                pointer = namespace / f"current-{uuid.uuid4()}"
                pointer.symlink_to(generation, target_is_directory=True)
                os.replace(pointer, namespace / "current")
                self.applied_revision = revision
                return self._finish(revision)
            except Exception:
                if revision:
                    try:
                        self._ack(revision, "failed", FAILED)
                    except Exception:
                        pass
                return {"revision": revision, "status": "failed", "error": FAILED}
            finally:
                if lock:
                    try:
                        lock.rmdir()  # Only our own empty lock; never remove other files.
                    except OSError:
                        pass
