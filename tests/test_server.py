"""HTTP tests: the server on a temporary database and a free port. Run: python3 -m unittest discover tests"""
import http.client
import json
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server  # noqa: E402


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        server.DATA_DIR = root
        server.BACKUP_DIR = root / "backups"
        server.SETTINGS_FILE = root / "settings.json"
        server.Handler.log_message = lambda *args: None  # keep the test output clean
        server.open_database(root / "finance.db")
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        server.database.close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        head = {"Host": f"localhost:{self.port}", **(headers or {})}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            head.setdefault("Content-Type", "application/json")
        conn.request(method, path, data, head)
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        kind = res.getheader("Content-Type", "")
        return res.status, (json.loads(raw) if kind.startswith("application/json") and raw[:1] in b"{[" else raw), res

    def test_flow(self):
        status, result, _ = self.call("POST", "/api/wallets", {"name": "Card", "currency": "usd", "balance": "100"})
        self.assertEqual(status, 200, result)
        card = result["id"]
        _, state, _ = self.call("GET", "/api/state")
        food = next(c["id"] for c in state["categories"] if c["path"] == "Food:Fruits")
        status, result, _ = self.call("POST", "/api/transactions", {"type": "expense", "date": "2026-11-07", "entries": [
            {"wallet_id": card, "amount": "-12.5", "category_id": food, "description": "яблоки"}]})
        self.assertEqual(status, 200, result)
        _, found, _ = self.call("GET", "/api/transactions?q=%D0%AF%D0%91%D0%9B%D0%9E%D0%9A%D0%98")  # "ЯБЛОКИ"
        self.assertEqual(len(found["transactions"]), 1)
        _, report, _ = self.call("GET", "/api/report?from=2026-11-01&to=2026-11-30")
        self.assertEqual(report["expense"]["total"], "12.50")
        status, result, _ = self.call("PUT", "/api/currencies/eur", {"rate": "1.1"})
        self.assertEqual(status, 200, result)
        status, result, _ = self.call("POST", "/api/undo", {})
        self.assertEqual(result["undone"], "Edit currency")
        _, state, _ = self.call("GET", "/api/state")
        self.assertTrue(state["can_undo"])
        self.assertIn("time", state["last_backup"])  # the daily backup was made before the first change

    def test_errors(self):
        status, result, _ = self.call("POST", "/api/transactions", {"type": "expense", "entries": []})
        self.assertEqual(status, 400)
        self.assertIn("line", result["error"])
        self.assertEqual(self.call("GET", "/api/nothing")[0], 404)
        self.assertEqual(self.call("DELETE", "/api/wallets/9999")[0], 404)

    def test_other_sites_are_refused(self):
        self.assertEqual(self.call("GET", "/api/state", headers={"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.call("GET", "/api/state", headers={"Host": "evil.example"})[0], 403)
        status, _, _ = self.call("POST", "/api/wallets", {"name": "X", "currency": "USD"},
                                 headers={"Content-Type": "text/plain"})
        self.assertEqual(status, 415)

    def test_downloads(self):
        status, body, res = self.call("GET", "/api/export.csv")
        self.assertEqual(status, 200)
        self.assertIn("attachment", res.getheader("Content-Disposition"))
        self.assertTrue(body.decode("utf-8-sig").startswith("date,type,wallet"))
        status, body, _ = self.call("GET", "/api/export.json")
        self.assertEqual(status, 200)
        self.assertIn("currencies", body)

    def test_settings_and_static(self):
        status, result, _ = self.call("PUT", "/api/settings", {"theme": "dark", "tx": {"month": "2026-11"}})
        self.assertEqual((status, result["theme"]), (200, "dark"))
        self.assertEqual(self.call("PUT", "/api/settings", {"theme": "pink"})[0], 400)
        status, body, _ = self.call("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"Finotello", body)


if __name__ == "__main__":
    unittest.main()
