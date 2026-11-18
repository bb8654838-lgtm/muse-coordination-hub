from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PhaseZeroContractTests(unittest.TestCase):
    def test_required_monorepo_artifacts_exist(self) -> None:
        required = [
            "package.json",
            ".env.example",
            "README.md",
            "LICENSE",
            "apps/web/package.json",
            "apps/web/app/page.tsx",
            "apps/web/app/globals.css",
            "apps/web/lib/supabase/client.ts",
            "apps/web/lib/supabase/admin.ts",
            "apps/web/app/api/agents/register/route.ts",
            "apps/web/app/api/agents/heartbeat/route.ts",
            "apps/web/app/api/inbox/route.ts",
            "apps/web/app/api/messages/route.ts",
            "apps/web/app/api/files/route.ts",
            "apps/web/app/api/tasks/[id]/ack/route.ts",
            "apps/web/app/api/tasks/[id]/complete/route.ts",
            "supabase/migrations/001_init.sql",
            "packages/bridge/src/client.mjs",
            "packages/bridge/src/cli.mjs",
            "packages/bridge/python/muse_bridge/client.py",
            "packages/bridge/python/muse_bridge/cli.py",
            "packages/skill/SKILL.md",
        ]
        missing = [path for path in required if not (ROOT / path).is_file()]
        self.assertEqual(missing, [], f"missing artifacts: {missing}")

    def test_migration_has_exactly_eight_rls_tables(self) -> None:
        sql = (ROOT / "supabase/migrations/001_init.sql").read_text().lower()
        expected = {
            "workspaces",
            "agents",
            "channels",
            "messages",
            "tasks",
            "files",
            "schedules",
            "heartbeats",
        }
        actual = set(
            re.findall(
                r"create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_]+)",
                sql,
            )
        )
        self.assertEqual(actual, expected)
        for table in sorted(expected):
            self.assertIn(
                f"alter table public.{table} enable row level security;", sql
            )
            self.assertRegex(sql, rf"create\s+policy\s+.+?\s+on\s+public\.{table}\b")

    def test_agent_limit_is_hard_enforced_in_schema_and_registration_api(self) -> None:
        sql = (ROOT / "supabase/migrations/001_init.sql").read_text().lower()
        route = (
            ROOT / "apps/web/app/api/agents/register/route.ts"
        ).read_text().lower()
        self.assertRegex(sql, r"agent_limit\s+smallint\s+not\s+null\s+default\s+10")
        self.assertRegex(sql, r"check\s*\(\s*agent_limit\s+between\s+1\s+and\s+10\s*\)")
        self.assertIn("enforce_workspace_agent_limit", sql)
        self.assertIn("create trigger enforce_agents_per_workspace", sql)
        self.assertIn("register_agent", sql)
        self.assertIn("agent_limit_reached", route)
        self.assertRegex(route, r"agent_limit_reached[\s\S]{0,240}\b409\b")

    def test_task_ack_uses_atomic_conditional_update(self) -> None:
        route = (
            ROOT / "apps/web/app/api/tasks/[id]/ack/route.ts"
        ).read_text()
        self.assertIn(
            '.update({ status: "IN_PROGRESS", locked_by: agent.id, locked_at: lockedAt })',
            route,
        )
        self.assertIn('.eq("assigned_to", agent.id)', route)
        self.assertIn('.eq("status", "PENDING")', route)
        self.assertIn('.is("locked_by", null)', route)
        self.assertIn('.maybeSingle()', route)
        self.assertRegex(route, r"if \(!data\)[\s\S]{0,320}\b409\b")

    def test_bridge_contract_covers_registration_and_task_lifecycle(self) -> None:
        combined = "\n".join(
            (ROOT / path).read_text()
            for path in [
                "packages/bridge/src/client.mjs",
                "packages/bridge/src/cli.mjs",
                "packages/bridge/python/muse_bridge/client.py",
                "packages/bridge/python/muse_bridge/cli.py",
            ]
        )
        for endpoint in [
            "/api/agents/register",
            "/api/agents/heartbeat",
            "/api/inbox",
            "/api/files",
            "/ack",
            "/complete",
        ]:
            self.assertIn(endpoint, combined)
        for field in ["display_name", "role"]:
            self.assertIn(field, combined)

    def test_skill_documents_protocol_channels_and_typed_messages(self) -> None:
        skill = (ROOT / "packages/skill/SKILL.md").read_text()
        for token in [
            "#general",
            "#handoff",
            "#alerts",
            "DM",
            "NOTE",
            "TASK",
            "HANDOFF",
            "ALERT",
            "DONE",
            "ACK",
        ]:
            self.assertIn(token, skill)

    def test_environment_contract_is_complete_and_secret_free(self) -> None:
        env = (ROOT / ".env.example").read_text()
        required = {
            "NEXT_PUBLIC_SUPABASE_URL",
            "NEXT_PUBLIC_SUPABASE_ANON_KEY",
            "SUPABASE_SERVICE_ROLE_KEY",
            "MUSE_AGENT_KEY_PEPPER",
            "MUSE_INVITE_KEY_PEPPER",
            "MUSE_HUB_URL",
            "MUSE_AGENT_KEY",
        }
        found = set(re.findall(r"^([A-Z][A-Z0-9_]+)=", env, re.MULTILINE))
        self.assertTrue(required.issubset(found), required - found)
        for line in env.splitlines():
            if line and not line.startswith("#") and "=" in line:
                _, value = line.split("=", 1)
                self.assertIn(value, {"", "http://localhost:3000"})

    def test_agents_are_registered_dynamically_without_seeded_identities(self) -> None:
        seed = (ROOT / "supabase/seed.sql").read_text().lower()
        registration = (
            ROOT / "apps/web/app/api/agents/register/route.ts"
        ).read_text()
        self.assertNotRegex(seed, r"insert\s+into\s+public\.agents")
        self.assertIn("display_name", registration)
        self.assertIn("role", registration)


if __name__ == "__main__":
    unittest.main()
