from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CommandCenterContractTests(unittest.TestCase):
    def read(self, path: str) -> str:
        return (ROOT / path).read_text(encoding="utf-8")

    def test_spatial_command_center_artifacts_exist(self) -> None:
        required = [
            "apps/web/components/network/muse-mark.tsx",
            "apps/web/components/network/muse-node.tsx",
            "apps/web/components/network/network-canvas.tsx",
            "apps/web/components/network/transfer-layer.tsx",
            "apps/web/components/network/preview-transfer.tsx",
            "apps/web/components/hooks/use-workspace-realtime.ts",
            "apps/web/components/hooks/use-transfer-queue.ts",
            "apps/web/lib/realtime-visual-events.ts",
            "apps/web/components/dashboard/command-center-shell.tsx",
            "apps/web/components/dashboard/overview-view.tsx",
            "apps/web/components/dashboard/comms-view.tsx",
            "apps/web/components/dashboard/fleet-view.tsx",
            "apps/web/components/dashboard/pipeline-view.tsx",
            "apps/web/components/dashboard/vault-view.tsx",
        ]
        self.assertEqual([path for path in required if not (ROOT / path).is_file()], [])

    def test_geist_fonts_and_command_center_palette_are_wired(self) -> None:
        layout = self.read("apps/web/app/layout.tsx")
        styles = self.read("apps/web/app/globals.css").lower()
        self.assertIn('from "next/font/google"', layout)
        self.assertIn("Geist", layout)
        self.assertIn("Geist_Mono", layout)
        for token in ["#060910", "#0e1824", "#6ee7c7", "#60a5fa", "#a78bfa", "#fbbf24", "#fb7185"]:
            self.assertIn(token, styles)
        self.assertIn("perspective: 1200px", styles)
        self.assertIn("font-variant-numeric: tabular-nums", styles)
        self.assertIn("prefers-reduced-motion: reduce", styles)

    def test_realtime_visual_pipeline_and_queue_guards_are_explicit(self) -> None:
        hook = self.read("apps/web/components/hooks/use-workspace-realtime.ts")
        queue = self.read("apps/web/components/hooks/use-transfer-queue.ts")
        mapper = self.read("apps/web/lib/realtime-visual-events.ts")
        for table in ["agents", "channels", "messages", "tasks", "files", "heartbeats"]:
            self.assertIn(f'table: "{table}"', hook)
        self.assertIn("120", hook)
        self.assertIn("visualEventFromRealtime", hook)
        self.assertIn("MAX_ACTIVE_TRANSFERS = 12", queue)
        self.assertIn("seenIds", queue)
        for kind in ["chat", "file", "task", "done"]:
            self.assertIn(f'"{kind}"', mapper)

    def test_network_is_accessible_and_preview_is_local_only(self) -> None:
        canvas = self.read("apps/web/components/network/network-canvas.tsx")
        preview = self.read("apps/web/components/network/preview-transfer.tsx")
        transfer = self.read("apps/web/components/network/transfer-layer.tsx")
        for key in ["ArrowRight", "ArrowLeft", "Home", "End"]:
            self.assertIn(key, canvas)
        self.assertIn('aria-live="polite"', canvas)
        self.assertIn("Preview Animation", preview)
        self.assertNotIn("fetch(", preview)
        self.assertNotIn("supabase", preview.lower())
        self.assertIn("animateMotion", transfer)

    def test_command_views_keep_operational_surfaces_and_credits(self) -> None:
        dashboard = self.read("apps/web/components/owner-dashboard.tsx")
        shell = self.read("apps/web/components/dashboard/command-center-shell.tsx") if (ROOT / "apps/web/components/dashboard/command-center-shell.tsx").is_file() else ""
        combined = "\n".join(
            self.read(path)
            for path in [
                "apps/web/components/dashboard/overview-view.tsx",
                "apps/web/components/dashboard/comms-view.tsx",
                "apps/web/components/dashboard/fleet-view.tsx",
                "apps/web/components/dashboard/pipeline-view.tsx",
                "apps/web/components/dashboard/vault-view.tsx",
            ]
            if (ROOT / path).is_file()
        )
        all_ui = dashboard + shell + combined
        for surface in ["Overview", "Fleet", "Comms", "Pipeline", "Vault"]:
            self.assertIn(surface, all_ui)
        for contract in ["NOTE", "HANDOFF", "TASK", "ALERT", "DONE", "Create and assign task", "/api/owner/files/"]:
            self.assertIn(contract, all_ui)
        self.assertIn("<CommandCenterShell", dashboard)
        self.assertIn('import { DeveloperCredit }', shell)
        self.assertIn("<DeveloperCredit", shell)

    def test_five_category_operational_contracts_are_explicit(self) -> None:
        shell = self.read("apps/web/components/dashboard/command-center-shell.tsx")
        overview = self.read("apps/web/components/dashboard/overview-view.tsx")
        fleet = self.read("apps/web/components/dashboard/fleet-view.tsx")
        comms = self.read("apps/web/components/dashboard/comms-view.tsx")
        pipeline = self.read("apps/web/components/dashboard/pipeline-view.tsx")
        vault = self.read("apps/web/components/dashboard/vault-view.tsx")
        for label in ["Overview", "Fleet", "Comms", "Pipeline", "Vault"]:
            self.assertIn(label, shell)
        self.assertIn("NetworkCanvas", overview)
        self.assertIn("ActivityStream", overview)
        for token in ["agentLimit", "Invite Key", "Revoke", "heartbeat"]:
            self.assertIn(token, fleet)
        for token in ["general", "handoff", "alerts", "NOTE", "TASK", "HANDOFF", "ALERT", "DONE"]:
            self.assertIn(token, comms)
        for status in ["PENDING", "IN_PROGRESS", "BLOCKED", "ESCALATED", "DONE"]:
            self.assertIn(status, pipeline)
        for token in ["uploaded", "picked", "posted", "/api/owner/files/"]:
            self.assertIn(token, vault)

    def test_web_dependency_contract_is_unchanged(self) -> None:
        package = json.loads(self.read("apps/web/package.json"))
        self.assertEqual(
            package["dependencies"],
            {
                "@supabase/ssr": "^0.12.7",
                "@supabase/supabase-js": "2.119.1",
                "next": "16.4.6",
                "react": "19.3.1",
                "react-dom": "19.3.1",
            },
        )


if __name__ == "__main__":
    unittest.main()
