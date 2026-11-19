from __future__ import annotations

import copy
import importlib.util
import json
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "packages/skills"
PRESETS = ["sales-growth", "full-stack-engineer", "content-media", "research-qa", "operations-coordinator", "product-ux", "security-privacy", "data-insights", "customer-success", "finance-planning"]


class SkillRegistryContractTests(unittest.TestCase):
    def test_all_ten_optional_presets_and_provenance(self) -> None:
        catalog = json.loads((REGISTRY / "catalog.json").read_text())
        self.assertEqual([p["id"] for p in catalog["presets"]], PRESETS)
        self.assertTrue(all(p["optional"] is True for p in catalog["presets"]))
        self.assertNotIn("default_preset", catalog)
        sources = json.loads((REGISTRY / "sources.lock.json").read_text())["sources"]
        self.assertTrue(sources)
        for source in sources:
            self.assertRegex(source["commit"], r"^[a-f0-9]{40}$")
            self.assertIn(source["license"], {"MIT", "Apache-2.0"})
            self.assertRegex(source["license_sha256"], r"^[a-f0-9]{64}$")
        for preset in catalog["presets"]:
            folder = REGISTRY / "presets" / preset["id"]
            for name in ["SKILL.md", "LICENSE.txt", "UPSTREAM.json", "ADAPTATIONS.md"]:
                self.assertTrue((folder / name).is_file(), f"{preset['id']}/{name}")
            self.assertGreater(len(preset["skill_ids"]), 0)

    def test_registry_validator_and_tamper_detection(self) -> None:
        spec = importlib.util.spec_from_file_location("registry_validator", ROOT / "scripts/validate_skill_registry.py")
        self.assertIsNotNone(spec)
        validator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(validator)
        self.assertEqual(validator.validate(ROOT), [])
        catalog = json.loads((REGISTRY / "catalog.json").read_text())
        tampered = copy.deepcopy(catalog)
        tampered["presets"][0]["skill_ids"].append("does-not-exist")
        self.assertTrue(validator.validate(ROOT, catalog=tampered))
        tampered = copy.deepcopy(catalog)
        tampered["skills"][0]["path"] = "../../.env.local"
        self.assertTrue(validator.validate(ROOT, catalog=tampered))

    def test_client_metadata_never_includes_skill_bodies_or_server_modules(self) -> None:
        client = (REGISTRY / "src/index.ts").read_text()
        self.assertIn("catalog.json", client)
        for forbidden in ["node:fs", "SKILL.md", "./server", "sources.lock.json"]:
            self.assertNotIn(forbidden, client)
        server = (REGISTRY / "src/server.ts").read_text()
        self.assertIn('import "server-only"', server)
        self.assertIn("readFile", server)
        self.assertIn("sha256", server)
        for name in ["catalog.schema.json", "sources.schema.json", "configuration.schema.json"]:
            schema = json.loads((REGISTRY / "schemas" / name).read_text())
            self.assertIn("$schema", schema)

    def test_configuration_validation_behavior(self) -> None:
        result = subprocess.run(["node", str(ROOT / "tests/skill_configuration_behavior.cjs")], cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("configuration behavior: PASS", result.stdout)

    def test_migration_is_atomic_owner_scoped_and_no_automatic_link_defaults(self) -> None:
        sql = (ROOT / "supabase/migrations/002_agent_configuration.sql").read_text().lower()
        for table in ["workspace_roles", "workspace_role_versions", "workspace_skill_versions", "agent_config_state", "agent_config_revisions", "agent_config_events"]:
            self.assertIn(f"create table if not exists public.{table}", sql)
            self.assertIn(f"alter table public.{table} enable row level security", sql)
            self.assertIn(f"alter table public.{table} force row level security", sql)
        self.assertIn("base_revision_conflict", sql)
        self.assertIn("for update", sql)
        self.assertIn("p_owner_id", sql)
        self.assertIn("configuration_saved", sql)
        self.assertNotIn("after insert on public.agents", sql)
        self.assertNotIn("create or replace function public.register_agent", sql)
        self.assertIn("revoke all on function", sql)

    def test_owner_routes_and_authenticated_admin_exist(self) -> None:
        for path, methods in {
            "roles/route.ts": ["GET", "POST"],
            "roles/[id]/route.ts": ["PATCH"],
            "skills/route.ts": ["GET", "POST"],
            "agents/[id]/configuration/route.ts": ["GET", "PUT"],
        }.items():
            source = (ROOT / "apps/web/app/api/owner" / path).read_text()
            self.assertIn("authorizeWorkspaceOwner", source)
            self.assertIn("workspaceId", source)
            for method in methods:
                self.assertIn(f"export async function {method}", source)
        configuration = (ROOT / "apps/web/app/api/owner/agents/[id]/configuration/route.ts").read_text()
        self.assertIn("409", configuration)
        self.assertIn("base_revision", configuration)
        page = (ROOT / "apps/web/app/admin/page.tsx").read_text()
        self.assertIn("supabase.auth.getUser()", page)
        self.assertIn('redirect("/login")', page)
        self.assertIn('.eq("owner_id", user.id)', page)

    def test_admin_mobile_access_and_honest_sync_copy(self) -> None:
        ui = (ROOT / "apps/web/components/admin/agent-configuration-panel.tsx").read_text()
        for phrase in ["Unconfigured", "Save configuration", "Cancel", "Token estimate", "Action permissions", "SKILL.md", "Not synced", "Stage B"]:
            self.assertIn(phrase, ui)
        self.assertIn("base_revision", ui)
        self.assertIn("409", ui)
        self.assertIn('aria-label=', ui)
        css = (ROOT / "apps/web/app/admin/admin.css").read_text()
        self.assertIn("390", css)
        self.assertIn("position: sticky", css)
        shell = (ROOT / "apps/web/components/dashboard/command-center-shell.tsx").read_text()
        fleet = (ROOT / "apps/web/components/dashboard/fleet-view.tsx").read_text()
        self.assertIn('href="/admin"', shell)
        self.assertIn("Manage Role &amp; Skills", fleet)


if __name__ == "__main__":
    unittest.main()
