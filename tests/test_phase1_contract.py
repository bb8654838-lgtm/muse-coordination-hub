from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PhaseOneContractTests(unittest.TestCase):
    def read(self, path: str) -> str:
        return (ROOT / path).read_text(encoding="utf-8")

    def test_owner_authentication_and_cookie_session_support(self) -> None:
        required = [
            "apps/web/proxy.ts",
            "apps/web/app/login/page.tsx",
            "apps/web/app/login/login-form.tsx",
            "apps/web/lib/supabase/server.ts",
            "apps/web/lib/server/owner-auth.ts",
        ]
        self.assertEqual([path for path in required if not (ROOT / path).is_file()], [])
        login = self.read("apps/web/app/login/login-form.tsx")
        dashboard = self.read("apps/web/components/owner-dashboard.tsx")
        page = self.read("apps/web/app/page.tsx")
        for method in ["signInWithPassword", "signOut", "updateUser"]:
            self.assertIn(method, login + dashboard)
        self.assertIn("supabase.auth.getUser()", page)
        self.assertRegex(page, r'\.eq\("owner_id",\s*user\.id\)')
        self.assertIn('redirect("/login")', page)

    def test_realtime_dashboard_subscribes_to_every_live_surface(self) -> None:
        dashboard = self.read("apps/web/components/owner-dashboard.tsx")
        self.assertIn("postgres_changes", dashboard)
        for table in ["agents", "channels", "messages", "tasks", "files", "heartbeats"]:
            self.assertRegex(dashboard, rf'table:\s*"{table}"')
        self.assertIn("workspace_id=eq.", dashboard)
        self.assertIn("last_seen_at", dashboard)
        self.assertIn("PRESENCE_WINDOW_MS", dashboard)

    def test_agent_invite_rotation_is_owner_only_and_cryptographically_random(self) -> None:
        route = self.read("apps/web/app/api/owner/invite/route.ts")
        self.assertIn("authorizeWorkspaceOwner", route)
        self.assertIn("randomBytes(32)", route)
        self.assertIn('requiredServerSecret("MUSE_INVITE_PEPPER")', route)
        self.assertIn("hashSecret", route)
        self.assertIn('"Cache-Control": "no-store, max-age=0"', route)
        self.assertNotIn("console.log", route)

    def test_agent_revoke_and_dm_routes_require_owner_authorization(self) -> None:
        for path in [
            "apps/web/app/api/owner/agents/[id]/revoke/route.ts",
            "apps/web/app/api/owner/channels/dm/route.ts",
            "apps/web/app/api/owner/files/[id]/download/route.ts",
        ]:
            source = self.read(path)
            self.assertIn("authorizeWorkspaceOwner", source, path)
            self.assertIn("workspaceId", source, path)
        revoke = self.read("apps/web/app/api/owner/agents/[id]/revoke/route.ts")
        self.assertIn('.update({ status: "revoked" })', revoke)

    def test_chat_tasks_and_handoffs_cover_phase_one_contract(self) -> None:
        dashboard = self.read("apps/web/components/owner-dashboard.tsx")
        for message_type in ["NOTE", "TASK", "HANDOFF", "ALERT", "DONE"]:
            self.assertIn(f'"{message_type}"', dashboard)
        for task_status in ["PENDING", "IN_PROGRESS", "DONE", "ESCALATED", "BLOCKED"]:
            self.assertIn(f'"{task_status}"', dashboard)
        for feature in [
            "member_agent_ids",
            "mentionIds",
            "Create and assign task",
            "result_link",
            "/api/owner/files/",
        ]:
            self.assertIn(feature, dashboard)

    def test_service_role_key_stays_in_server_only_module(self) -> None:
        client_sources = [
            ROOT / "apps/web/components/owner-dashboard.tsx",
            ROOT / "apps/web/app/login/login-form.tsx",
            ROOT / "apps/web/lib/supabase/client.ts",
        ]
        for path in client_sources:
            self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", path.read_text(), str(path))
        admin = self.read("apps/web/lib/supabase/admin.ts")
        self.assertIn('import "server-only"', admin)
        self.assertIn("SUPABASE_SERVICE_ROLE_KEY", admin)


if __name__ == "__main__":
    unittest.main()
