import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class DeveloperCreditsContractTests(unittest.TestCase):
    def test_shared_footer_has_official_external_links(self):
        source = (ROOT / "apps/web/components/developer-credit.tsx").read_text()
        self.assertIn("Developed by:", source)
        self.assertIn("Entouraged.sam", source)
        self.assertIn('href="https://github.com/LegendGod01"', source)
        self.assertIn('href="https://entouraged-sam.vercel.app/"', source)
        self.assertEqual(source.count('target="_blank"'), 3)
        self.assertEqual(source.count('rel="noopener noreferrer"'), 3)

    def test_footer_is_rendered_on_login_and_dashboard(self):
        login = (ROOT / "apps/web/app/login/login-form.tsx").read_text()
        dashboard = (ROOT / "apps/web/components/owner-dashboard.tsx").read_text()
        for source in (login, dashboard):
            self.assertIn('import { DeveloperCredit }', source)
            self.assertIn("<DeveloperCredit", source)

    def test_repository_metadata_has_official_credits(self):
        package = json.loads((ROOT / "package.json").read_text())
        self.assertEqual(
            package.get("author"),
            "Entouraged.sam <https://entouraged-sam.vercel.app/>",
        )
        readme = (ROOT / "README.md").read_text()
        self.assertIn("## Developer Credits", readme)
        self.assertIn("[Entouraged.sam](https://entouraged-sam.vercel.app/)", readme)
        self.assertIn("[github.com/LegendGod01](https://github.com/LegendGod01)", readme)
        self.assertIn("[entouraged-sam.vercel.app](https://entouraged-sam.vercel.app/)", readme)


if __name__ == "__main__":
    unittest.main()
