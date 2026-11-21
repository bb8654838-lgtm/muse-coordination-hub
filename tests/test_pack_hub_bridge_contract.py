from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "apps" / "web"


class PackHubBridgeContractTests(unittest.TestCase):
    def test_admin_pack_page_and_navigation_exist(self) -> None:
        page = WEB / "app" / "admin" / "packs" / "page.tsx"
        panel = WEB / "components" / "admin" / "pack-management-panel.tsx"
        self.assertTrue(page.is_file())
        self.assertTrue(panel.is_file())
        self.assertIn('href="/admin/packs"', (WEB / "app" / "admin" / "page.tsx").read_text())

    def test_four_pack_proxy_routes_use_shared_owner_bridge(self) -> None:
        expected = {
            "status": "GET",
            "catalog": "GET",
            "activate": "POST",
            "install": "POST",
        }
        for endpoint, method in expected.items():
            source = (WEB / "app" / "api" / "packs" / endpoint / "route.ts").read_text()
            self.assertIn(f"export async function {method}", source)
            self.assertIn("proxyCommerceRequest", source)

        helper = (WEB / "lib" / "server" / "commerce-proxy.ts").read_text()
        for required in (
            "authorizeWorkspaceOwner",
            "session.access_token",
            '"x-muse-workspace"',
            'Authorization: `Bearer ${session.access_token}`',
            "MUSE_COMMERCE_API_URL",
            "commerce_not_configured",
        ):
            self.assertIn(required, helper)

    def test_public_bridge_url_is_documented_without_pack_artifacts(self) -> None:
        example = (ROOT / ".env.example").read_text()
        self.assertIn("MUSE_COMMERCE_API_URL=", example)
        self.assertFalse(any(ROOT.rglob("*.musepack")))


if __name__ == "__main__":
    unittest.main()
