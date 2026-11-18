#!/usr/bin/env python3
"""Validate Phase 0 invariants without connecting to a database."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "001_init.sql"
ACK_ROUTE = ROOT / "apps" / "web" / "app" / "api" / "tasks" / "[id]" / "ack" / "route.ts"
EXPECTED_TABLES = {
    "workspaces",
    "agents",
    "channels",
    "messages",
    "tasks",
    "files",
    "schedules",
    "heartbeats",
}


def contains(sql: str, pattern: str) -> bool:
    return re.search(pattern, sql, flags=re.IGNORECASE | re.DOTALL) is not None


def main() -> int:
    sql = MIGRATION.read_text(encoding="utf-8")
    ack_route = ACK_ROUTE.read_text(encoding="utf-8")
    tables = set(re.findall(r"\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_]+)\s*\(", sql, re.I))
    failures: list[str] = []

    if tables != EXPECTED_TABLES:
        failures.append(
            f"public table set mismatch: expected {sorted(EXPECTED_TABLES)}, got {sorted(tables)}"
        )

    for table in sorted(EXPECTED_TABLES):
        if not contains(sql, rf"alter\s+table\s+public\.{table}\s+enable\s+row\s+level\s+security"):
            failures.append(f"{table}: RLS is not enabled")
        if not contains(sql, rf"alter\s+table\s+public\.{table}\s+force\s+row\s+level\s+security"):
            failures.append(f"{table}: RLS is not forced")
        if not contains(sql, rf"create\s+policy\s+\w+\s+on\s+public\.{table}\b"):
            failures.append(f"{table}: no RLS policy found")

    required_patterns = {
        "agent_limit default 10": r"agent_limit\s+smallint\s+not\s+null\s+default\s+10",
        "agent_limit capped at 10": r"check\s*\(\s*agent_limit\s+between\s+1\s+and\s+10\s*\)",
        "database agent-limit trigger": r"create\s+trigger\s+enforce_agents_per_workspace",
        "atomic registration function": r"create\s+or\s+replace\s+function\s+public\.register_agent",
        "default channel trigger": r"create\s+trigger\s+create_workspace_default_channels",
        "private handoff bucket": r"values\s*\(\s*'handoffs'\s*,\s*'handoffs'\s*,\s*false",
        "Realtime publication": r"alter\s+publication\s+supabase_realtime\s+add\s+table",
    }
    for label, pattern in required_patterns.items():
        if not contains(sql, pattern):
            failures.append(f"missing {label}")

    ack_patterns = {
        "atomic ACK transition": r'\.update\(\{\s*status:\s*"IN_PROGRESS",\s*locked_by:\s*agent\.id,\s*locked_at:\s*lockedAt\s*\}\)',
        "ACK assignment guard": r'\.eq\("assigned_to",\s*agent\.id\)',
        "ACK pending-state guard": r'\.eq\("status",\s*"PENDING"\)',
        "ACK unlocked guard": r'\.is\("locked_by",\s*null\)',
        "ACK single-row result": r'\.maybeSingle\(\)',
    }
    for label, pattern in ack_patterns.items():
        if not contains(ack_route, pattern):
            failures.append(f"missing {label}")

    for message_type in ("NOTE", "TASK", "HANDOFF", "ALERT", "DONE"):
        if f"'{message_type}'" not in sql:
            failures.append(f"missing message type {message_type}")
    for task_status in ("PENDING", "IN_PROGRESS", "DONE", "ESCALATED", "BLOCKED"):
        if f"'{task_status}'" not in sql:
            failures.append(f"missing task status {task_status}")

    if failures:
        print("schema validation: FAIL", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print("schema validation: PASS (8 tables, forced RLS, hard agent cap, atomic API task ACK)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
