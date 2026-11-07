#!/usr/bin/env python3
"""Finotello: local server.

Serves the web UI from web/ and a REST API; data lives in data/finance.db (SQLite, see db.py).
Python standard library only.

Run:  python3 server.py [port] [--backup-dir PATH]   (default port 8010, backups in data/backups)
Settings can also live in a .env file next to this one (see .env.example).
"""
import argparse
import json
import os
import re
import sys
import traceback
from datetime import date, datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import db
from db import ApiError

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_FILE = DATA_DIR / "finance.db"
BACKUP_DIR = DATA_DIR / "backups"  # can be changed at start: --backup-dir, or FIN_BACKUP_DIR (in .env)
ENV_FILE = ROOT / ".env"
SETTINGS_FILE = DATA_DIR / "settings.json"
WEB_DIR = ROOT / "web"

KEEP_BACKUPS = 14
THEMES = ("light", "dark", "system")
SETTINGS_MAX_BYTES = 64 * 1024
MAX_BODY_BYTES = 1024 * 1024  # one API request
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")  # names the API answers to (see Handler.check_caller)

database = None  # db.Database, opened in main()


# ---------- backups ----------
# Backups live in BACKUP_DIR (data/backups/ by default):
#   finance-YYYY-MM-DD.db           daily, made before the first change of the day
#   finance-YYYY-MM-DD_HH-MM-SS.db  made with the Backup button
# The last KEEP_BACKUPS of each kind are kept, so clicking the button often never pushes out the daily ones.
# Each is a complete SQLite file: to roll back, stop the server and copy one over data/finance.db.

def prune_backups():
    daily = sorted(BACKUP_DIR.glob("finance-????-??-??.db"))
    manual = sorted(BACKUP_DIR.glob("finance-????-??-??_*.db"))
    for old in daily[:-KEEP_BACKUPS] + manual[:-KEEP_BACKUPS]:
        old.unlink(missing_ok=True)


def backup_daily():
    """Before the first change of the day, copy the database to BACKUP_DIR."""
    target = BACKUP_DIR / f"finance-{date.today().isoformat()}.db"
    if target.exists():
        return
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    database.backup_to(target)
    prune_backups()


def backup_now():
    """The Backup button: copy the database right away."""
    try:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        target = BACKUP_DIR / f"finance-{datetime.now():%Y-%m-%d_%H-%M-%S}.db"
        database.backup_to(target)
        prune_backups()
    except (OSError, db.sqlite3.Error) as e:
        raise ApiError(f"Backup failed: {e}", 500) from None
    return {"ok": True, "file": target.name, "last_backup": last_backup()}


def last_backup():
    """{time, file, dir} of the newest backup, or {dir} alone when there is none yet."""
    newest, newest_time = None, 0
    for path in BACKUP_DIR.glob("finance-*.db") if BACKUP_DIR.exists() else []:
        try:
            made = path.stat().st_mtime
        except OSError:
            continue  # removed meanwhile
        if made > newest_time:
            newest, newest_time = path, made
    info = {"dir": str(BACKUP_DIR)}
    if newest:
        info.update(time=datetime.fromtimestamp(newest_time).isoformat(timespec="seconds"), file=newest.name)
    return info


# ---------- UI settings (data/settings.json) ----------
# Theme and per-tab view options. Kept apart from the database: no undo, no backups.

def load_settings():
    try:
        with SETTINGS_FILE.open(encoding="utf-8") as f:
            settings = json.load(f)
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        print(f"Warning: {SETTINGS_FILE.name} is unreadable ({e}); using defaults.", file=sys.stderr)
        return {}
    return settings if isinstance(settings, dict) else {}


def update_settings(body):
    """Merge the given top-level keys: "theme" is a string, every other key is one tab's options object."""
    for key, value in body.items():
        if key == "theme":
            if value not in THEMES:
                raise ApiError(f"theme must be one of: {', '.join(THEMES)}")
        elif not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", key):
            raise ApiError(f"Invalid settings key: {key!r}")
        elif not isinstance(value, dict):
            raise ApiError(f"Settings for {key!r} must be an object")
    with database.lock:
        settings = {**load_settings(), **body}
        text = json.dumps(settings, ensure_ascii=False, indent=2) + "\n"
        if len(text.encode("utf-8")) > SETTINGS_MAX_BYTES:
            raise ApiError("Settings are too large")
        DATA_DIR.mkdir(exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".json.tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, SETTINGS_FILE)
    return settings


# ---------- API ----------

def state():
    result = database.read(db.get_state)
    result["can_undo"] = database.can_undo()
    result["last_backup"] = last_backup()
    return result


def change(label, fn, takes_body=True):
    """A route handler that runs fn(change, [item], [body]) as one undoable action."""
    def handler(body, item, query):
        args = ([] if item is None else [item]) + ([body or {}] if takes_body else [])
        return database.write(label, fn, *args)
    return handler


def download(content, filename, content_type):
    return {"_download": (content.encode("utf-8"), filename, content_type)}


ROUTES = [
    # (method, path, handler(body, item, query)); item is the (\w+) group: an id, or a currency code
    ("GET", r"/api/state", lambda b, i, q: state()),
    ("GET", r"/api/transactions", lambda b, i, q: database.read(db.list_transactions, q)),
    ("GET", r"/api/report", lambda b, i, q: database.read(db.get_report, q)),
    ("GET", r"/api/planned/(\d+)/savings", lambda b, i, q: database.read(db.plan_savings_list, i)),
    ("GET", r"/api/export\.json", lambda b, i, q: download(
        json.dumps(database.read(db.export_json), ensure_ascii=False, indent=2),
        f"finotello-{date.today().isoformat()}.json", "application/json; charset=utf-8")),
    ("GET", r"/api/export\.csv", lambda b, i, q: download(
        "﻿" + database.read(db.export_csv),  # BOM: Excel then reads the file as UTF-8
        f"finotello-transactions-{date.today().isoformat()}.csv", "text/csv; charset=utf-8")),
    ("POST", r"/api/undo", lambda b, i, q: database.undo()),
    ("POST", r"/api/backup", lambda b, i, q: backup_now()),
    ("GET", r"/api/settings", lambda b, i, q: load_settings()),
    ("PUT", r"/api/settings", lambda b, i, q: update_settings(b)),
    ("PUT", r"/api/config", change("Change settings", db.update_config)),

    ("POST", r"/api/transactions", change("Add transaction", db.create_transaction)),
    ("PUT", r"/api/transactions/(\d+)", change("Edit transaction", db.update_transaction)),
    ("DELETE", r"/api/transactions/(\d+)", change("Delete transaction", db.delete_transaction, takes_body=False)),

    ("POST", r"/api/wallets", change("Add wallet", db.create_wallet)),
    ("PUT", r"/api/wallets/(\d+)", change("Edit wallet", db.update_wallet)),
    ("DELETE", r"/api/wallets/(\d+)", change("Delete wallet", db.delete_wallet, takes_body=False)),
    ("POST", r"/api/wallets/(\d+)/reconcile", change("Balance check", db.reconcile_wallet)),

    ("POST", r"/api/categories", change("Add category", db.create_category)),
    ("PUT", r"/api/categories/(\d+)", change("Edit category", db.update_category)),
    ("DELETE", r"/api/categories/(\d+)", change("Delete category", db.delete_category, takes_body=False)),
    ("POST", r"/api/categories/(\d+)/merge", change("Merge categories", db.merge_category)),

    ("POST", r"/api/currencies", change("Add currency", db.create_currency)),
    ("PUT", r"/api/currencies/([A-Za-z0-9]+)", change("Edit currency", db.update_currency)),
    ("DELETE", r"/api/currencies/([A-Za-z0-9]+)", change("Remove currency", db.delete_currency, takes_body=False)),

    ("POST", r"/api/recurring", change("Add monthly payment", db.create_recurring)),
    ("PUT", r"/api/recurring/(\d+)", change("Edit monthly payment", db.update_recurring)),
    ("DELETE", r"/api/recurring/(\d+)", change("Delete monthly payment", db.delete_recurring, takes_body=False)),
    ("POST", r"/api/recurring/(\d+)/pay", change("Pay", db.pay_recurring)),

    ("POST", r"/api/planned", change("Add plan", db.create_planned)),
    ("PUT", r"/api/planned/(\d+)", change("Edit plan", db.update_planned)),
    ("DELETE", r"/api/planned/(\d+)", change("Delete plan", db.delete_planned, takes_body=False)),
    ("POST", r"/api/planned/(\d+)/save", change("Save for a plan", db.save_for_plan)),
    ("POST", r"/api/planned/(\d+)/buy", change("Buy", db.buy_planned)),
    ("POST", r"/api/planned/(\d+)/drop", change("Drop plan", db.drop_planned, takes_body=False)),
]


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html; charset=utf-8",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_request(self, code="-", size="-"):
        # Keep the console quiet for successful requests; errors are still shown.
        if not str(code).startswith(("2", "3")):
            super().log_request(code, size)

    def send_body(self, body, content_type, code=200, filename=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, code=200):
        self.send_body(json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", code)

    def read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0:
            self.close_connection = True
            raise ApiError("Invalid Content-Length")
        if not length:
            return {}
        if length > MAX_BODY_BYTES:
            self.close_connection = True  # the body is left unread
            raise ApiError(f"Request is too large (at most {MAX_BODY_BYTES // 1024} KB)", 413)
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError("Invalid JSON in request") from None
        if not isinstance(body, dict):
            raise ApiError("Expected a JSON object")
        return body

    def check_caller(self, method):
        """Only this app may use the API. Another site open in the browser could otherwise send requests here:
        a form-like POST (text/plain) needs no permission from the server, and a renamed host (DNS rebinding)
        could even read the data. So the Host must be this machine, a given Origin must be this server,
        and changes must come as JSON (a cross-site JSON request is blocked by the browser)."""
        host = (self.headers.get("Host") or "").lower()
        if host.rsplit(":", 1)[0].strip("[]") not in LOCAL_HOSTS:
            raise ApiError("Forbidden host", 403)
        origin = self.headers.get("Origin")
        if origin and origin.lower() != f"http://{host}":
            raise ApiError("Requests from other sites are not allowed", 403)
        if method in ("POST", "PUT"):
            ctype = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
            if ctype != "application/json":
                self.close_connection = True
                raise ApiError("Send JSON (Content-Type: application/json)", 415)

    def handle_api(self, method):
        url = urlsplit(self.path)
        path = url.path.rstrip("/")
        if not path.startswith("/api/"):
            return False
        try:
            self.check_caller(method)
            for route_method, pattern, handler in ROUTES:
                match = re.fullmatch(pattern, path)
                if match and route_method == method:
                    item = None
                    if match.groups():
                        item = match.group(1)
                        item = int(item) if item.isdigit() else item.upper()
                    body = self.read_body() if method in ("POST", "PUT") else None
                    query = dict(parse_qsl(url.query))
                    result = handler(body, item, query)
                    if isinstance(result, dict) and "_download" in result:
                        content, filename, content_type = result["_download"]
                        self.send_body(content, content_type, filename=filename)
                    else:
                        self.send_json(result)
                    return True
            raise ApiError("No such API endpoint", 404)
        except ApiError as e:
            self.send_json({"error": str(e)}, e.code)
        except Exception as e:  # noqa: BLE001 — show the error in the UI instead of crashing
            traceback.print_exc()
            self.send_json({"error": f"Internal server error: {e}"}, 500)
        return True

    def do_GET(self):
        if not self.handle_api("GET"):
            super().do_GET()

    def do_POST(self):
        if not self.handle_api("POST"):
            self.send_error(404)

    def do_PUT(self):
        if not self.handle_api("PUT"):
            self.send_error(404)

    def do_DELETE(self):
        if not self.handle_api("DELETE"):
            self.send_error(404)


def load_env_file(path=ENV_FILE):
    """Read KEY=VALUE lines from .env into the environment (no packages needed).
    Blank lines and # comments are skipped; quotes around a value are dropped.
    A variable already set in the real environment wins over the file."""
    if not path.exists():
        return
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.removeprefix("export ").partition("=")
        key, value = key.strip(), value.strip()
        if not sep or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            print(f"Warning: {path.name} line {number} is not KEY=VALUE, skipped", file=sys.stderr)
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def open_database(path=DB_FILE):
    global database
    path.parent.mkdir(parents=True, exist_ok=True)
    database = db.Database(path, before_write=backup_daily, migration_backup_dir=BACKUP_DIR)
    return database


def main():
    global DATA_DIR, DB_FILE, SETTINGS_FILE, BACKUP_DIR
    load_env_file()
    parser = argparse.ArgumentParser(description="Finotello: local personal finance tracker.")
    parser.add_argument("port", nargs="?", type=int, default=int(os.environ.get("FIN_PORT") or 8010),
                        help="port to listen on (default 8010; also FIN_PORT)")
    parser.add_argument("--data-dir", default=os.environ.get("FIN_DATA_DIR"),
                        help="folder with finance.db and settings.json (default: data; also FIN_DATA_DIR), "
                             "e.g. a second set of books or a test copy")
    parser.add_argument("--backup-dir", default=os.environ.get("FIN_BACKUP_DIR"),
                        help="folder for the backups, e.g. on another disk or a synced folder "
                             "(default: backups inside the data folder; also FIN_BACKUP_DIR, e.g. in .env)")
    args = parser.parse_args()
    if args.data_dir:
        DATA_DIR = Path(args.data_dir).expanduser().resolve()
        DB_FILE = DATA_DIR / "finance.db"
        SETTINGS_FILE = DATA_DIR / "settings.json"
        BACKUP_DIR = DATA_DIR / "backups"
    if args.backup_dir:
        BACKUP_DIR = Path(args.backup_dir).expanduser().resolve()
    try:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)  # fail now, not on the first change of the day
    except OSError as e:
        sys.exit(f"Cannot use {BACKUP_DIR} for backups: {e}")
    try:
        open_database(DB_FILE)
    except (ApiError, db.sqlite3.DatabaseError) as e:
        sys.exit(f"Cannot open {DB_FILE}: {e}. Backups are in {BACKUP_DIR}")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Finotello: http://localhost:{args.port}   (Ctrl+C to stop)", flush=True)
    print(f"Data: {DB_FILE}\nBackups: {BACKUP_DIR}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        database.close()


if __name__ == "__main__":
    main()
