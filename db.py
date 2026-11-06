"""Finotello storage: the SQLite schema, money math, undo, and every change and query the API needs.

Python standard library only. One connection, guarded by a lock (the HTTP server is threaded).

Money: amounts are stored as integers in the currency's smallest unit ("minor units": cents, kopecks,
satoshi), 10 ** decimals per unit, so sums never pick up float rounding errors. The API speaks in
ordinary units as strings ("12.30"); to_minor() and from_minor() convert between the two.

A transaction is split into entries: one entry is one change of one wallet's balance, in that wallet's
currency, optionally with a category and a description. A wallet's balance is the sum of its entries.
Debts are wallets too (type "debt", one per person): above zero they owe you, below zero you owe them.
"""
import csv
import io
import json
import re
import sqlite3
import threading
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation, localcontext

WALLET_TYPES = ("bank", "cash", "crypto", "debt")
MONEY_TYPES = ("bank", "cash", "crypto")  # wallets that hold your own money (not debts)
TX_TYPES = ("expense", "income", "transfer", "debt", "adjustment")
CATEGORY_KINDS = ("expense", "income")
CURRENCY_KINDS = ("fiat", "crypto")
PRIORITIES = ("high", "medium", "low")
PLAN_STATUSES = ("open", "done", "dropped")
UNDO_DEPTH = 30  # actions Ctrl+Z can take back; kept in the database, so they survive a restart

# Limits for what you type. The UI reads them from /api/state and stops typing there.
LIMITS = {
    "name": 60,             # wallet, monthly payment, plan
    "category_name": 40,    # shown as "Category:Subcategory" in narrow places
    "currency_name": 40,
    "note": 500,            # a transaction's note, a wallet's note
    "description": 200,     # one line of a transaction
    "plan_notes": 2000,
    "entries": 50,          # lines in one transaction
    "amount": 10_000_000_000,     # one amount, in units: with 8 decimals it still fits in 64 bits
    "rate": 1_000_000_000_000,    # base currency per one unit of a currency
}

# Categorical palette (same as the UI). New wallets and top-level categories take the first unused color.
PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
OTHER_COLOR = "#9a9893"

# Primary key column of each table (the rest use "id").
KEYS = {"currencies": "code", "config": "key"}
TABLES = ("config", "currencies", "wallets", "categories", "recurring", "planned", "plan_savings",
          "transactions", "entries")


class ApiError(Exception):
    def __init__(self, message, code=400):
        super().__init__(message)
        self.code = code


def today():
    return date.today().isoformat()


def now():
    return datetime.now().isoformat(timespec="seconds")


# ---------- schema ----------

SCHEMA_1 = [
    """CREATE TABLE config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )""",
    """CREATE TABLE currencies (
        code         TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('fiat', 'crypto')),
        decimals     INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 8),
        rate         TEXT NOT NULL DEFAULT '0',   -- base currency per 1 unit, a decimal as text; 0 = not set
        rate_updated TEXT
    )""",
    """CREATE TABLE wallets (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL CHECK (type IN ('bank', 'cash', 'crypto', 'debt')),
        currency    TEXT NOT NULL REFERENCES currencies(code),
        color       TEXT NOT NULL,
        note        TEXT NOT NULL DEFAULT '',
        is_cushion  INTEGER NOT NULL DEFAULT 0,
        is_archived INTEGER NOT NULL DEFAULT 0,
        is_deleted  INTEGER NOT NULL DEFAULT 0,
        created     TEXT NOT NULL
    )""",
    """CREATE TABLE categories (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
        parent_id  INTEGER REFERENCES categories(id),
        color      TEXT NOT NULL,
        is_active  INTEGER NOT NULL DEFAULT 1,
        is_deleted INTEGER NOT NULL DEFAULT 0
    )""",
    """CREATE TABLE recurring (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        amount      INTEGER NOT NULL,
        currency    TEXT NOT NULL REFERENCES currencies(code),
        category_id INTEGER REFERENCES categories(id),
        wallet_id   INTEGER REFERENCES wallets(id),
        day         INTEGER NOT NULL DEFAULT 1 CHECK (day BETWEEN 1 AND 31),
        is_active   INTEGER NOT NULL DEFAULT 1,
        is_deleted  INTEGER NOT NULL DEFAULT 0,
        created     TEXT NOT NULL
    )""",
    """CREATE TABLE planned (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        amount      INTEGER NOT NULL,
        currency    TEXT NOT NULL REFERENCES currencies(code),
        category_id INTEGER REFERENCES categories(id),
        priority    TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
        due         TEXT,
        notes       TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
        created     TEXT NOT NULL,
        done_at     TEXT,
        is_deleted  INTEGER NOT NULL DEFAULT 0
    )""",
    """CREATE TABLE plan_savings (
        id         INTEGER PRIMARY KEY,
        planned_id INTEGER NOT NULL REFERENCES planned(id),
        date       TEXT NOT NULL,
        amount     INTEGER NOT NULL,              -- in the plan's currency; below zero = taken back
        note       TEXT NOT NULL DEFAULT '',
        created    TEXT NOT NULL
    )""",
    """CREATE TABLE transactions (
        id           INTEGER PRIMARY KEY,
        date         TEXT NOT NULL,
        type         TEXT NOT NULL CHECK (type IN ('expense', 'income', 'transfer', 'debt', 'adjustment')),
        note         TEXT NOT NULL DEFAULT '',
        recurring_id INTEGER REFERENCES recurring(id),
        planned_id   INTEGER REFERENCES planned(id),
        created      TEXT NOT NULL,
        is_deleted   INTEGER NOT NULL DEFAULT 0
    )""",
    """CREATE TABLE entries (
        id             INTEGER PRIMARY KEY,
        transaction_id INTEGER NOT NULL REFERENCES transactions(id),
        wallet_id      INTEGER NOT NULL REFERENCES wallets(id),
        amount         INTEGER NOT NULL,          -- in the wallet's currency, with a sign
        category_id    INTEGER REFERENCES categories(id),
        description    TEXT NOT NULL DEFAULT ''
    )""",
    """CREATE TABLE undo_log (
        id      INTEGER PRIMARY KEY,
        batch   INTEGER NOT NULL,                 -- one user action
        label   TEXT NOT NULL,                    -- "Add transaction", shown after undo
        tbl     TEXT NOT NULL,
        row_key TEXT NOT NULL,                    -- JSON
        before  TEXT                              -- the row as JSON before the change; NULL = it didn't exist
    )""",
    "CREATE INDEX transactions_date ON transactions(date)",
    "CREATE INDEX entries_transaction ON entries(transaction_id)",
    "CREATE INDEX entries_wallet ON entries(wallet_id)",
    "CREATE INDEX entries_category ON entries(category_id)",
    "CREATE INDEX undo_batch ON undo_log(batch)",
]

SEED_CURRENCIES = [
    ("USD", "US dollar", "fiat", 2),
    ("EUR", "Euro", "fiat", 2),
    ("RUB", "Russian ruble", "fiat", 2),
    ("BTC", "Bitcoin", "crypto", 8),
    ("ETH", "Ether", "crypto", 8),
    ("USDT", "Tether", "crypto", 6),
]
SEED_CATEGORIES = {
    "expense": [
        ("Food", ["Groceries", "Fruits", "Eating out"]),
        ("Housing", ["Rent", "Utilities"]),
        ("Transport", []),
        ("Health", ["Medicine", "Dentist"]),
        ("Shopping", []),
        ("Entertainment", []),
        ("Subscriptions", []),
        ("Fees", []),
    ],
    "income": [("Salary", []), ("Freelance", []), ("Gifts", []), ("Other", [])],
}


def migration_1(conn):
    for statement in SCHEMA_1:
        conn.execute(statement)
    conn.execute("INSERT INTO config (key, value) VALUES ('base_currency', 'USD'), ('cushion_target', '0')")
    for code, name, kind, decimals in SEED_CURRENCIES:
        conn.execute("INSERT INTO currencies (code, name, kind, decimals, rate) VALUES (?, ?, ?, ?, ?)",
                     (code, name, kind, decimals, "1" if code == "USD" else "0"))
    for kind, tree in SEED_CATEGORIES.items():
        for n, (name, subs) in enumerate(tree):
            color = PALETTE[n] if n < len(PALETTE) and name != "Fees" else OTHER_COLOR
            parent = conn.execute("INSERT INTO categories (name, kind, color) VALUES (?, ?, ?)",
                                  (name, kind, color)).lastrowid
            for sub in subs:
                conn.execute("INSERT INTO categories (name, kind, parent_id, color) VALUES (?, ?, ?, ?)",
                             (sub, kind, parent, color))


# Migrations by number: MIGRATIONS[n] brings the database from version n to n + 1 (PRAGMA user_version).
# Add new ones at the end; never change one that has shipped.
MIGRATIONS = [migration_1]


def migrate(conn):
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version > len(MIGRATIONS):
        raise ApiError(f"The database is from a newer version of Finotello (schema {version})", 500)
    for number in range(version, len(MIGRATIONS)):
        conn.execute("BEGIN IMMEDIATE")
        try:
            MIGRATIONS[number](conn)
            conn.execute(f"PRAGMA user_version = {number + 1}")
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise


# ---------- input checks ----------

def as_str(value, label, limit, required=False):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(f"{label} must be text")
    value = value.strip()
    if required and not value:
        raise ApiError(f"{label} is required")
    if len(value) > limit:
        raise ApiError(f"{label} is too long (at most {limit} characters)")
    return value


def as_bool(value, label):
    if isinstance(value, bool):
        return value
    if value in (0, 1):
        return bool(value)
    raise ApiError(f"{label} must be true or false")


def as_int(value, label, lo=None, hi=None):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ApiError(f"{label} must be a whole number")
    try:
        number = int(value)
    except ValueError:
        raise ApiError(f"{label} must be a whole number") from None
    if (lo is not None and number < lo) or (hi is not None and number > hi):
        raise ApiError(f"{label} must be between {lo} and {hi}")
    return number


def as_id(value, label):
    """An id, or None for an empty value."""
    if value is None or value == "":
        return None
    return as_int(value, label, 1)


def as_date(value, label, required=True):
    if value is None or value == "":
        if required:
            raise ApiError(f"{label} is required")
        return None
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ApiError(f"{label} must be a date YYYY-MM-DD")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ApiError(f"{label} is not a real date") from None
    return value


def as_choice(value, label, choices):
    if value not in choices:
        raise ApiError(f"{label} must be one of: {', '.join(choices)}")
    return value


def as_color(value):
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ApiError("Color must look like #2a78d6")
    return value.lower()


def as_code(value):
    code = value.strip().upper() if isinstance(value, str) else ""
    if not re.fullmatch(r"[A-Z0-9]{2,10}", code):
        raise ApiError("Currency code must be 2–10 letters or digits, e.g. USD or BTC")
    return code


def as_decimal(value, label):
    """A number from JSON: a string ("1 234,50" is fine), an int or a float."""
    if isinstance(value, bool) or value is None:
        raise ApiError(f"{label} is required")
    if isinstance(value, float):
        text = repr(value)
    elif isinstance(value, int):
        text = str(value)
    elif isinstance(value, str):
        text = re.sub(r"[\s\u00a0\u202f']", "", value).replace(",", ".").replace("\u2212", "-")
        if not text:
            raise ApiError(f"{label} is required")
    else:
        raise ApiError(f"{label} must be a number")
    try:
        number = Decimal(text)
    except InvalidOperation:
        raise ApiError(f"{label} must be a number") from None
    if not number.is_finite():
        raise ApiError(f"{label} must be a number")
    return number


def to_minor(value, decimals, label="Amount"):
    """"12.30" with 2 decimals -> 1230. More decimals than the currency has is an error, not rounding."""
    number = as_decimal(value, label)
    if abs(number) > LIMITS["amount"]:
        raise ApiError(f"{label} is too large (at most {LIMITS['amount']:,})")
    scaled = number.scaleb(decimals)
    if scaled != scaled.to_integral_value():
        raise ApiError(f"{label}: at most {decimals} digits after the point" if decimals else f"{label} must be whole")
    return int(scaled)


def from_minor(minor, decimals):
    """1230 with 2 decimals -> "12.30"."""
    if not decimals:
        return str(minor)
    sign = "-" if minor < 0 else ""
    digits = str(abs(minor)).rjust(decimals + 1, "0")
    return f"{sign}{digits[:-decimals]}.{digits[-decimals:]}"


def dec_str(number):
    """A Decimal as plain text without trailing zeros: 0.000015, 92000, 1.5."""
    if number == 0:
        return "0"
    text = format(number, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def like_pattern(text):
    """Text for "contains" search with LIKE ... ESCAPE '\\'."""
    return "%" + re.sub(r"([\\%_])", r"\\\1", text.casefold()) + "%"


# ---------- connection, changes and undo ----------

class Change:
    """One user action: every row it inserts, updates or deletes is logged in undo_log under one batch number,
    with the row as it was before, so the whole action can be taken back."""

    def __init__(self, conn, label):
        self.conn = conn
        self.label = label
        self.batch = conn.execute("SELECT COALESCE(MAX(batch), 0) + 1 FROM undo_log").fetchone()[0]

    def _log(self, table, key, before):
        self.conn.execute(
            "INSERT INTO undo_log (batch, label, tbl, row_key, before) VALUES (?, ?, ?, ?, ?)",
            (self.batch, self.label, table, json.dumps(key),
             None if before is None else json.dumps(dict(before), ensure_ascii=False)))

    def row(self, table, key):
        return self.conn.execute(f"SELECT * FROM {table} WHERE {KEYS.get(table, 'id')} = ?", (key,)).fetchone()

    def insert(self, table, values):
        columns = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        cursor = self.conn.execute(f"INSERT INTO {table} ({columns}) VALUES ({marks})", tuple(values.values()))
        key = values[KEYS[table]] if table in KEYS else cursor.lastrowid
        self._log(table, key, None)
        return key

    def update(self, table, key, values):
        before = self.row(table, key)
        if before is None:
            raise ApiError("Not found", 404)
        values = {k: v for k, v in values.items() if before[k] != v}
        if not values:
            return
        self._log(table, key, before)
        sets = ", ".join(f"{column} = ?" for column in values)
        self.conn.execute(f"UPDATE {table} SET {sets} WHERE {KEYS.get(table, 'id')} = ?", (*values.values(), key))

    def delete(self, table, key):
        before = self.row(table, key)
        if before is None:
            return
        self._log(table, key, before)
        self.conn.execute(f"DELETE FROM {table} WHERE {KEYS.get(table, 'id')} = ?", (key,))

    def finish(self):
        """Keep the last UNDO_DEPTH actions."""
        self.conn.execute("DELETE FROM undo_log WHERE batch <= ?", (self.batch - UNDO_DEPTH,))


class Database:
    def __init__(self, path, before_write=None):
        """before_write: called (under the lock) before every change, e.g. for the daily backup."""
        self.path = path
        self.lock = threading.RLock()
        self.before_write = before_write
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.execute("PRAGMA busy_timeout = 5000")
        self.conn.create_function("casefold", 1, lambda s: s.casefold() if isinstance(s, str) else s,
                                  deterministic=True)
        with self.lock:
            migrate(self.conn)

    def close(self):
        with self.lock:
            self.conn.close()

    def read(self, fn, *args):
        with self.lock:
            return fn(self.conn, *args)

    def write(self, label, fn, *args):
        """Run fn(change, *args) as one action: all of it is saved, or none of it."""
        with self.lock:
            if self.before_write:
                self.before_write()
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                change = Change(self.conn, label)
                result = fn(change, *args)
                change.finish()
                self.conn.execute("COMMIT")
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            return result

    def can_undo(self):
        with self.lock:
            return self.conn.execute("SELECT 1 FROM undo_log LIMIT 1").fetchone() is not None

    def undo(self):
        """Take back the last action: put every row it touched back the way it was, newest change first."""
        with self.lock:
            if self.before_write:
                self.before_write()
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                batch = self.conn.execute("SELECT MAX(batch) FROM undo_log").fetchone()[0]
                if batch is None:
                    raise ApiError("Nothing to undo")
                rows = self.conn.execute("SELECT * FROM undo_log WHERE batch = ? ORDER BY id DESC", (batch,)).fetchall()
                for row in rows:
                    self._restore(row["tbl"], json.loads(row["row_key"]), row["before"])
                self.conn.execute("DELETE FROM undo_log WHERE batch = ?", (batch,))
                self.conn.execute("COMMIT")
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            return {"ok": True, "undone": rows[0]["label"] if rows else ""}

    def _restore(self, table, key, before):
        if table not in TABLES:
            raise ApiError(f"Unknown table in the undo log: {table}", 500)
        key_column = KEYS.get(table, "id")
        if before is None:
            self.conn.execute(f"DELETE FROM {table} WHERE {key_column} = ?", (key,))
            return
        values = json.loads(before)
        exists = self.conn.execute(f"SELECT 1 FROM {table} WHERE {key_column} = ?", (key,)).fetchone()
        if exists:
            sets = ", ".join(f"{column} = ?" for column in values)
            self.conn.execute(f"UPDATE {table} SET {sets} WHERE {key_column} = ?", (*values.values(), key))
        else:
            columns = ", ".join(values)
            marks = ", ".join("?" for _ in values)
            self.conn.execute(f"INSERT INTO {table} ({columns}) VALUES ({marks})", tuple(values.values()))

    def backup_to(self, target):
        """Copy the whole database to the file target (safe while it is open)."""
        with self.lock:
            copy = sqlite3.connect(target)
            try:
                self.conn.backup(copy)
            finally:
                copy.close()


# ---------- lookups ----------

def config(conn):
    return {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM config")}


def get_currency(conn, code):
    row = conn.execute("SELECT * FROM currencies WHERE code = ?", (code,)).fetchone()
    if row is None:
        raise ApiError(f"Unknown currency: {code}")
    return row


def get_live(conn, table, item_id, what):
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ? AND is_deleted = 0", (item_id,)).fetchone()
    if row is None:
        raise ApiError(f"{what} not found", 404)
    return row


def wallet_with_currency(conn, wallet_id):
    return conn.execute(
        "SELECT w.*, c.decimals FROM wallets w JOIN currencies c ON c.code = w.currency WHERE w.id = ?",
        (wallet_id,)).fetchone()


def next_color(conn, table, where="1"):
    used = {row[0].lower() for row in conn.execute(f"SELECT color FROM {table} WHERE is_deleted = 0 AND {where}")}
    return next((color for color in PALETTE if color not in used), OTHER_COLOR)


class Rates:
    """Converts amounts to the base currency at the current (manually entered) rates."""

    def __init__(self, conn):
        self.base = config(conn)["base_currency"]
        self.currencies = {row["code"]: (row["decimals"], Decimal(row["rate"]))
                           for row in conn.execute("SELECT code, decimals, rate FROM currencies")}
        self.base_decimals = self.currencies[self.base][0]

    def decimals(self, code):
        return self.currencies[code][0]

    def to_base(self, minor, code):
        """Minor units of code -> minor units of the base currency."""
        if code == self.base:
            return minor
        decimals, rate = self.currencies[code]
        with localcontext() as ctx:
            ctx.prec = 60
            value = (Decimal(minor) * rate).scaleb(self.base_decimals - decimals)
            return int(value.to_integral_value(rounding=ROUND_HALF_UP))

    def from_base(self, minor, code):
        """Minor units of the base currency -> minor units of code (0 if code has no rate)."""
        if code == self.base:
            return minor
        decimals, rate = self.currencies[code]
        if not rate:
            return 0
        with localcontext() as ctx:
            ctx.prec = 60
            value = (Decimal(minor) / rate).scaleb(decimals - self.base_decimals)
            return int(value.to_integral_value(rounding=ROUND_HALF_UP))

    def fmt(self, minor, code=None):
        return from_minor(minor, self.currencies[code or self.base][0])

    def fmt_base(self, minor):
        return from_minor(minor, self.base_decimals)


def wallet_balances(conn, wallet_id=None):
    """{wallet_id: balance in minor units} from the entries of transactions that aren't deleted."""
    sql = """SELECT e.wallet_id, SUM(e.amount) AS total FROM entries e
             JOIN transactions t ON t.id = e.transaction_id AND t.is_deleted = 0"""
    params = ()
    if wallet_id is not None:
        sql += " WHERE e.wallet_id = ?"
        params = (wallet_id,)
    return {row["wallet_id"]: row["total"] for row in conn.execute(sql + " GROUP BY e.wallet_id", params)}


# ---------- wallets ----------

def check_wallet_name(conn, name, except_id=None):
    for row in conn.execute("SELECT id, name FROM wallets WHERE is_deleted = 0"):
        if row["id"] != except_id and row["name"].casefold() == name.casefold():
            raise ApiError(f'There is already a wallet named "{row["name"]}"')


def create_wallet(c, body):
    name = as_str(body.get("name"), "Name", LIMITS["name"], required=True)
    kind = as_choice(body.get("type", "bank"), "Type", WALLET_TYPES)
    currency = get_currency(c.conn, as_code(body.get("currency")))
    check_wallet_name(c.conn, name)
    color = as_color(body["color"]) if body.get("color") else next_color(c.conn, "wallets")
    is_cushion = as_bool(body.get("is_cushion", False), "Counts toward the cushion")
    if kind == "debt" and is_cushion:
        raise ApiError("A debt can't count toward the cushion")
    wallet_id = c.insert("wallets", {
        "name": name, "type": kind, "currency": currency["code"], "color": color,
        "note": as_str(body.get("note"), "Note", LIMITS["note"]), "is_cushion": int(is_cushion),
        "created": now(),
    })
    opening = body.get("balance")
    if opening not in (None, ""):
        amount = to_minor(opening, currency["decimals"], "Starting balance")
        if amount:
            insert_transaction(c, "adjustment", as_date(body.get("date") or today(), "Date"),
                               "Starting balance", [{"wallet_id": wallet_id, "amount": amount,
                                                     "category_id": None, "description": ""}])
    return {"ok": True, "id": wallet_id}


def update_wallet(c, wallet_id, body):
    wallet = get_live(c.conn, "wallets", wallet_id, "Wallet")
    values = {}
    if "name" in body:
        values["name"] = as_str(body["name"], "Name", LIMITS["name"], required=True)
        check_wallet_name(c.conn, values["name"], wallet_id)
    has_entries = c.conn.execute("SELECT 1 FROM entries WHERE wallet_id = ? LIMIT 1", (wallet_id,)).fetchone()
    if "type" in body:
        values["type"] = as_choice(body["type"], "Type", WALLET_TYPES)
        if has_entries and (values["type"] == "debt") != (wallet["type"] == "debt"):
            raise ApiError("A wallet with transactions can't turn into a debt or back")
    if "currency" in body:
        values["currency"] = get_currency(c.conn, as_code(body["currency"]))["code"]
        if has_entries and values["currency"] != wallet["currency"]:
            raise ApiError("The currency can't change once a wallet has transactions")
    if "color" in body:
        values["color"] = as_color(body["color"])
    if "note" in body:
        values["note"] = as_str(body["note"], "Note", LIMITS["note"])
    if "is_cushion" in body:
        values["is_cushion"] = int(as_bool(body["is_cushion"], "Counts toward the cushion"))
    if "is_archived" in body:
        values["is_archived"] = int(as_bool(body["is_archived"], "Archived"))
    if values.get("is_cushion", wallet["is_cushion"]) and values.get("type", wallet["type"]) == "debt":
        raise ApiError("A debt can't count toward the cushion")
    c.update("wallets", wallet_id, values)
    return {"ok": True}


def delete_wallet(c, wallet_id):
    get_live(c.conn, "wallets", wallet_id, "Wallet")
    used = c.conn.execute("""SELECT 1 FROM entries e JOIN transactions t ON t.id = e.transaction_id
                             WHERE e.wallet_id = ? AND t.is_deleted = 0 LIMIT 1""", (wallet_id,)).fetchone()
    if used:
        raise ApiError("This wallet has transactions. Archive it instead, or delete its transactions first")
    for row in c.conn.execute("SELECT id FROM recurring WHERE wallet_id = ?", (wallet_id,)).fetchall():
        c.update("recurring", row["id"], {"wallet_id": None})
    c.update("wallets", wallet_id, {"is_deleted": 1})
    return {"ok": True}


def reconcile_wallet(c, wallet_id, body):
    """The real balance is X: record the difference as an adjustment."""
    get_live(c.conn, "wallets", wallet_id, "Wallet")
    wallet = wallet_with_currency(c.conn, wallet_id)
    target = to_minor(body.get("balance"), wallet["decimals"], "Balance")
    current = wallet_balances(c.conn, wallet_id).get(wallet_id, 0)
    diff = target - current
    if diff:
        insert_transaction(c, "adjustment", as_date(body.get("date") or today(), "Date"),
                           as_str(body.get("note"), "Note", LIMITS["note"]) or "Balance check",
                           [{"wallet_id": wallet_id, "amount": diff, "category_id": None, "description": ""}])
    return {"ok": True, "diff": from_minor(diff, wallet["decimals"])}


# ---------- transactions ----------

def clean_entries(conn, raw, tx_type, previous=()):
    """Checks the lines of a transaction. previous: the lines it had before an edit; a wallet or category
    deleted since then may stay on it, but can't be picked anew."""
    if not isinstance(raw, list) or not raw:
        raise ApiError("A transaction needs at least one line")
    if len(raw) > LIMITS["entries"]:
        raise ApiError(f"At most {LIMITS['entries']} lines in one transaction")
    old_wallets = {e["wallet_id"] for e in previous}
    old_categories = {e["category_id"] for e in previous}
    entries = []
    for n, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            raise ApiError("Each line must be an object")
        label = f"Line {n}" if len(raw) > 1 else "Amount"
        wallet_id = as_id(item.get("wallet_id"), "Wallet")
        if wallet_id is None:
            raise ApiError(f"{label}: pick a wallet")
        wallet = wallet_with_currency(conn, wallet_id)
        if wallet is None or (wallet["is_deleted"] and wallet_id not in old_wallets):
            raise ApiError(f"{label}: wallet not found")
        amount = to_minor(item.get("amount"), wallet["decimals"], label)
        if not amount:
            raise ApiError(f"{label}: the amount can't be zero")
        category_id = as_id(item.get("category_id"), "Category")
        category = None
        if category_id is not None:
            category = conn.execute("SELECT * FROM categories WHERE id = ?", (category_id,)).fetchone()
            if category is None or (category["is_deleted"] and category_id not in old_categories):
                raise ApiError(f"{label}: category not found")
        entries.append({
            "wallet_id": wallet_id, "amount": amount, "category_id": category_id,
            "description": as_str(item.get("description"), "Description", LIMITS["description"]),
            "_wallet": wallet, "_category": category,
        })
    check_entries(tx_type, entries)
    return entries


def check_entries(tx_type, entries):
    """What each type of transaction may contain."""
    def kinds_must_be(kind):
        for e in entries:
            if e["_category"] is not None and e["_category"]["kind"] != kind:
                raise ApiError(f'"{e["_category"]["name"]}" is an {e["_category"]["kind"]} category')

    if tx_type == "expense":
        if any(e["amount"] > 0 for e in entries):
            raise ApiError("An expense takes money out: amounts must be below zero")
        kinds_must_be("expense")
    elif tx_type == "income":
        if any(e["amount"] < 0 for e in entries):
            raise ApiError("Income brings money in: amounts must be above zero")
        kinds_must_be("income")
    elif tx_type == "adjustment":
        if len(entries) != 1 or entries[0]["category_id"] is not None:
            raise ApiError("A balance adjustment is one line without a category")
    else:  # transfer, debt: money moves between wallets; lines with a category are fees
        fees = [e for e in entries if e["category_id"] is not None]
        moves = [e for e in entries if e["category_id"] is None]
        for fee in fees:
            if fee["amount"] > 0 or fee["_category"]["kind"] != "expense":
                raise ApiError("A fee is an expense: below zero, with an expense category")
        if not any(e["amount"] < 0 for e in moves) or not any(e["amount"] > 0 for e in moves):
            raise ApiError("Money has to leave one wallet and arrive in another")
        if len({e["_wallet"]["currency"] for e in moves}) == 1 and sum(e["amount"] for e in moves):
            raise ApiError("The amount sent and the amount received must match (put a fee on its own line)")
        debts = [e for e in moves if e["_wallet"]["type"] == "debt"]
        if tx_type == "transfer" and debts:
            raise ApiError("Money to or from a person is a debt, not a transfer")
        if tx_type == "debt" and not debts:
            raise ApiError("A debt moves money to or from a person")


def insert_transaction(c, tx_type, tx_date, note, entries, recurring_id=None, planned_id=None):
    tx_id = c.insert("transactions", {
        "date": tx_date, "type": tx_type, "note": note,
        "recurring_id": recurring_id, "planned_id": planned_id, "created": now(),
    })
    for e in entries:
        c.insert("entries", {"transaction_id": tx_id, "wallet_id": e["wallet_id"], "amount": e["amount"],
                             "category_id": e["category_id"], "description": e["description"]})
    return tx_id


def check_link(conn, table, item_id, what):
    if item_id is not None and conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (item_id,)).fetchone() is None:
        raise ApiError(f"{what} not found")
    return item_id


def create_transaction(c, body):
    tx_type = as_choice(body.get("type"), "Type", TX_TYPES)
    entries = clean_entries(c.conn, body.get("entries"), tx_type)
    tx_id = insert_transaction(
        c, tx_type, as_date(body.get("date") or today(), "Date"),
        as_str(body.get("note"), "Note", LIMITS["note"]), entries,
        check_link(c.conn, "recurring", as_id(body.get("recurring_id"), "Monthly payment"), "Monthly payment"),
        check_link(c.conn, "planned", as_id(body.get("planned_id"), "Plan"), "Plan"))
    return {"ok": True, "id": tx_id}


def update_transaction(c, tx_id, body):
    tx = get_live(c.conn, "transactions", tx_id, "Transaction")
    values = {}
    if "date" in body:
        values["date"] = as_date(body["date"], "Date")
    if "note" in body:
        values["note"] = as_str(body["note"], "Note", LIMITS["note"])
    if "type" in body:
        values["type"] = as_choice(body["type"], "Type", TX_TYPES)
    for key, table, what in (("recurring_id", "recurring", "Monthly payment"), ("planned_id", "planned", "Plan")):
        if key in body:
            values[key] = check_link(c.conn, table, as_id(body[key], what), what)
    old = c.conn.execute("SELECT * FROM entries WHERE transaction_id = ? ORDER BY id", (tx_id,)).fetchall()
    tx_type = values.get("type", tx["type"])
    if "entries" in body:
        entries = clean_entries(c.conn, body["entries"], tx_type, old)
        same = [(e["wallet_id"], e["amount"], e["category_id"], e["description"]) for e in entries] == \
               [(e["wallet_id"], e["amount"], e["category_id"], e["description"]) for e in old]
        if not same:
            for e in old:
                c.delete("entries", e["id"])
            for e in entries:
                c.insert("entries", {"transaction_id": tx_id, "wallet_id": e["wallet_id"], "amount": e["amount"],
                                     "category_id": e["category_id"], "description": e["description"]})
    elif "type" in body:
        clean_entries(c.conn, entries_as_input(c.conn, old), tx_type, old)  # the old lines must fit the new type
    c.update("transactions", tx_id, values)
    return {"ok": True}


def entries_as_input(conn, rows):
    """Stored lines in the form the API takes them (amounts in units)."""
    out = []
    for e in rows:
        wallet = wallet_with_currency(conn, e["wallet_id"])
        out.append({"wallet_id": e["wallet_id"], "amount": from_minor(e["amount"], wallet["decimals"]),
                    "category_id": e["category_id"], "description": e["description"]})
    return out


def delete_transaction(c, tx_id):
    tx = get_live(c.conn, "transactions", tx_id, "Transaction")
    c.update("transactions", tx_id, {"is_deleted": 1})
    if tx["planned_id"] is not None:
        # Deleting the purchase of a plan opens the plan again.
        plan = c.row("planned", tx["planned_id"])
        other = c.conn.execute("SELECT 1 FROM transactions WHERE planned_id = ? AND is_deleted = 0 LIMIT 1",
                               (tx["planned_id"],)).fetchone()
        if plan and plan["status"] == "done" and not other:
            c.update("planned", plan["id"], {"status": "open", "done_at": None})
    return {"ok": True}


def list_transactions(conn, query):
    """Transactions with their lines, newest first. query: from, to, wallet, category (with its subcategories),
    type, q (text in the note or a line's description), limit."""
    where, params = ["t.is_deleted = 0"], []
    if query.get("id"):
        where.append("t.id = ?")
        params.append(as_id(query["id"], "Transaction"))
    if query.get("from"):
        where.append("t.date >= ?")
        params.append(as_date(query["from"], "From"))
    if query.get("to"):
        where.append("t.date <= ?")
        params.append(as_date(query["to"], "To"))
    if query.get("type"):
        where.append("t.type = ?")
        params.append(as_choice(query["type"], "Type", TX_TYPES))
    if query.get("wallet"):
        where.append("EXISTS (SELECT 1 FROM entries x WHERE x.transaction_id = t.id AND x.wallet_id = ?)")
        params.append(as_id(query["wallet"], "Wallet"))
    if query.get("category"):
        category_id = as_id(query["category"], "Category")
        where.append("""EXISTS (SELECT 1 FROM entries x WHERE x.transaction_id = t.id AND x.category_id IN
                        (SELECT id FROM categories WHERE id = ? OR parent_id = ?))""")
        params += [category_id, category_id]
    if query.get("q"):
        pattern = like_pattern(str(query["q"]).strip())
        where.append("""(casefold(t.note) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM entries x
                        WHERE x.transaction_id = t.id AND casefold(x.description) LIKE ? ESCAPE '\\'))""")
        params += [pattern, pattern]
    limit = as_int(query.get("limit", 2000), "Limit", 1, 10_000)
    rows = conn.execute(f"SELECT t.* FROM transactions t WHERE {' AND '.join(where)} "
                        "ORDER BY t.date DESC, t.id DESC LIMIT ?", (*params, limit + 1)).fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    lines = {}
    if rows:
        ids = [row["id"] for row in rows]
        for chunk in range(0, len(ids), 500):
            part = ids[chunk:chunk + 500]
            for e in conn.execute(
                    f"""SELECT e.*, w.currency, c.decimals FROM entries e
                        JOIN wallets w ON w.id = e.wallet_id JOIN currencies c ON c.code = w.currency
                        WHERE e.transaction_id IN ({','.join('?' * len(part))}) ORDER BY e.id""", part):
                lines.setdefault(e["transaction_id"], []).append({
                    "id": e["id"], "wallet_id": e["wallet_id"], "currency": e["currency"],
                    "amount": from_minor(e["amount"], e["decimals"]),
                    "category_id": e["category_id"], "description": e["description"],
                })
    return {
        "transactions": [{
            "id": row["id"], "date": row["date"], "type": row["type"], "note": row["note"],
            "recurring_id": row["recurring_id"], "planned_id": row["planned_id"], "created": row["created"],
            "entries": lines.get(row["id"], []),
        } for row in rows],
        "more": more,
    }


# ---------- categories ----------

def category_path(conn, category):
    if category["parent_id"] is None:
        return category["name"]
    parent = conn.execute("SELECT name FROM categories WHERE id = ?", (category["parent_id"],)).fetchone()
    return f"{parent['name']}:{category['name']}"


def check_category_name(conn, name, kind, parent_id, except_id=None):
    if ":" in name:
        raise ApiError('A category name can\'t contain ":" (it separates a category from its subcategory)')
    siblings = conn.execute(
        "SELECT id, name FROM categories WHERE is_deleted = 0 AND kind = ? AND parent_id IS ?", (kind, parent_id))
    for row in siblings:
        if row["id"] != except_id and row["name"].casefold() == name.casefold():
            where = "here" if parent_id is None else "in this category"
            raise ApiError(f'There is already a category "{row["name"]}" {where}')


def find_category(conn, name, kind, parent_id):
    for row in conn.execute("SELECT * FROM categories WHERE is_deleted = 0 AND kind = ? AND parent_id IS ?",
                            (kind, parent_id)):
        if row["name"].casefold() == name.casefold():
            return row
    return None


def top_level_parent(conn, parent_id, kind):
    parent = get_live(conn, "categories", parent_id, "Parent category")
    if parent["parent_id"] is not None:
        raise ApiError("Categories go two levels deep: a subcategory can't have its own subcategories")
    if parent["kind"] != kind:
        raise ApiError(f'"{parent["name"]}" is an {parent["kind"]} category')
    return parent


def create_category(c, body):
    """{kind, name, parent_id?, color?} or {kind, path: "Food:Snacks"}: a path creates whatever is missing."""
    kind = as_choice(body.get("kind", "expense"), "Kind", CATEGORY_KINDS)
    limit = LIMITS["category_name"]
    if body.get("path"):
        parts = [p.strip() for p in as_str(body["path"], "Category", limit * 2 + 1, required=True).split(":")]
        if len(parts) > 2 or not all(parts):
            raise ApiError("Write a category as Category or Category:Subcategory")
        parent_name, name = (parts[0], parts[1]) if len(parts) == 2 else (None, parts[0])
        parent_id = None
        if parent_name:
            as_str(parent_name, "Category name", limit)
            parent = find_category(c.conn, parent_name, kind, None)
            parent_id = parent["id"] if parent else c.insert("categories", {
                "name": parent_name, "kind": kind, "color": next_color(c.conn, "categories", f"parent_id IS NULL AND kind = '{kind}'"),
            })
        existing = find_category(c.conn, name, kind, parent_id)
        if existing:
            if not existing["is_active"]:
                c.update("categories", existing["id"], {"is_active": 1})
            return {"ok": True, "id": existing["id"], "existed": True}
    else:
        name = as_str(body.get("name"), "Name", limit, required=True)
        parent_id = as_id(body.get("parent_id"), "Parent category")
    name = as_str(name, "Name", limit, required=True)
    if parent_id is not None:
        parent = top_level_parent(c.conn, parent_id, kind)
        color = parent["color"]
    else:
        color = as_color(body["color"]) if body.get("color") else next_color(c.conn, "categories", f"parent_id IS NULL AND kind = '{kind}'")
    check_category_name(c.conn, name, kind, parent_id)
    category_id = c.insert("categories", {"name": name, "kind": kind, "parent_id": parent_id, "color": color})
    return {"ok": True, "id": category_id}


def live_children(conn, category_id):
    return conn.execute("SELECT * FROM categories WHERE parent_id = ? AND is_deleted = 0 ORDER BY id",
                        (category_id,)).fetchall()


def update_category(c, category_id, body):
    category = get_live(c.conn, "categories", category_id, "Category")
    values = {}
    parent_id = category["parent_id"]
    if "parent_id" in body:
        parent_id = as_id(body["parent_id"], "Parent category")
        if parent_id == category_id:
            raise ApiError("A category can't be inside itself")
        if parent_id is not None:
            if live_children(c.conn, category_id):
                raise ApiError("This category has subcategories, so it can't become a subcategory itself")
            top_level_parent(c.conn, parent_id, category["kind"])
        values["parent_id"] = parent_id
    name = category["name"]
    if "name" in body:
        name = values["name"] = as_str(body["name"], "Name", LIMITS["category_name"], required=True)
    if "name" in body or "parent_id" in body:
        check_category_name(c.conn, name, category["kind"], parent_id, category_id)
    if "is_active" in body:
        values["is_active"] = int(as_bool(body["is_active"], "Active"))
    if "color" in body and parent_id is None:
        values["color"] = as_color(body["color"])
        for child in live_children(c.conn, category_id):
            c.update("categories", child["id"], {"color": values["color"]})
    if parent_id is not None and parent_id != category["parent_id"]:
        values["color"] = c.row("categories", parent_id)["color"]
    c.update("categories", category_id, values)
    return {"ok": True}


def delete_category(c, category_id):
    """Soft delete, with its subcategories. Transactions keep pointing at it and show it struck through."""
    get_live(c.conn, "categories", category_id, "Category")
    for child in live_children(c.conn, category_id):
        c.update("categories", child["id"], {"is_deleted": 1})
    c.update("categories", category_id, {"is_deleted": 1})
    return {"ok": True}


def move_category_refs(c, source_id, target_id):
    for table, column in (("entries", "category_id"), ("recurring", "category_id"), ("planned", "category_id")):
        for row in c.conn.execute(f"SELECT id FROM {table} WHERE {column} = ?", (source_id,)).fetchall():
            c.update(table, row["id"], {column: target_id})


def merge_category(c, category_id, body):
    """Move everything in this category into another one, then delete it.
    A top-level category brings its subcategories along: each joins the target's subcategory of the same name,
    or moves under the target."""
    source = get_live(c.conn, "categories", category_id, "Category")
    target_id = as_id(body.get("into"), "Target category")
    if target_id is None or target_id == category_id:
        raise ApiError("Pick another category to merge into")
    target = get_live(c.conn, "categories", target_id, "Target category")
    if target["kind"] != source["kind"]:
        raise ApiError("Expense and income categories can't be merged")
    children = live_children(c.conn, category_id)
    if children and target["parent_id"] is not None:
        raise ApiError("A category with subcategories can only merge into a top-level category")
    if target["parent_id"] == category_id:
        raise ApiError("Merge into a category outside this one")
    for child in children:
        twin = find_category(c.conn, child["name"], source["kind"], target_id)
        if twin:
            move_category_refs(c, child["id"], twin["id"])
            c.update("categories", child["id"], {"is_deleted": 1})
        else:
            c.update("categories", child["id"], {"parent_id": target_id, "color": target["color"]})
    move_category_refs(c, category_id, target_id)
    c.update("categories", category_id, {"is_deleted": 1})
    return {"ok": True}


# ---------- currencies and settings ----------

def as_rate(value):
    rate = as_decimal(value, "Rate")
    if rate < 0 or rate > LIMITS["rate"]:
        raise ApiError(f"Rate must be between 0 and {LIMITS['rate']:,}")
    return dec_str(rate)


def currency_used(conn, code):
    for table in ("wallets", "recurring", "planned"):
        if conn.execute(f"SELECT 1 FROM {table} WHERE currency = ? LIMIT 1", (code,)).fetchone():
            return True
    return False


def create_currency(c, body):
    code = as_code(body.get("code"))
    if c.row("currencies", code):
        raise ApiError(f"{code} is already in the list")
    kind = as_choice(body.get("kind", "fiat"), "Kind", CURRENCY_KINDS)
    decimals = as_int(body.get("decimals", 2 if kind == "fiat" else 8), "Decimals", 0, 8)
    rate = as_rate(body.get("rate", "0"))
    c.insert("currencies", {"code": code, "name": as_str(body.get("name"), "Name", LIMITS["currency_name"]) or code,
                            "kind": kind, "decimals": decimals, "rate": rate,
                            "rate_updated": now() if rate != "0" else None})
    return {"ok": True, "code": code}


def update_currency(c, code, body):
    currency = get_currency(c.conn, code)
    values = {}
    if "name" in body:
        values["name"] = as_str(body["name"], "Name", LIMITS["currency_name"]) or code
    if "kind" in body:
        values["kind"] = as_choice(body["kind"], "Kind", CURRENCY_KINDS)
    if "decimals" in body:
        values["decimals"] = as_int(body["decimals"], "Decimals", 0, 8)
        if values["decimals"] != currency["decimals"] and currency_used(c.conn, code):
            raise ApiError("Decimals can't change once the currency is in use")
    if "rate" in body:
        if code == config(c.conn)["base_currency"]:
            raise ApiError("The base currency's rate is always 1")
        values["rate"] = as_rate(body["rate"])
        if values["rate"] != currency["rate"]:
            values["rate_updated"] = now()
    c.update("currencies", code, values)
    return {"ok": True}


def delete_currency(c, code):
    get_currency(c.conn, code)
    if code == config(c.conn)["base_currency"]:
        raise ApiError("The base currency can't be removed")
    if currency_used(c.conn, code):
        raise ApiError("This currency is in use (a wallet, payment or plan has it)")
    c.delete("currencies", code)
    return {"ok": True}


def update_config(c, body):
    cfg = config(c.conn)
    base = cfg["base_currency"]
    if "base_currency" in body and as_code(body["base_currency"]) != base:
        new = get_currency(c.conn, as_code(body["base_currency"]))
        # How much of the old base one unit of the new base costs: its rate, or the one given with the switch.
        factor = Decimal(as_rate(body["base_rate"])) if body.get("base_rate") not in (None, "") else Decimal(new["rate"])
        rows = c.conn.execute("SELECT code, rate FROM currencies").fetchall()
        others_set = any(Decimal(r["rate"]) for r in rows if r["code"] not in (base, new["code"]))
        if not factor and (others_set or int(cfg["cushion_target"])):
            raise ApiError(f"Enter how much 1 {new['code']} costs in {base}: the other rates are recounted through it")
        old_decimals = get_currency(c.conn, base)["decimals"]
        with localcontext() as ctx:
            ctx.prec = 28
            for row in rows:
                if row["code"] == new["code"]:
                    rate = Decimal(1)
                elif not factor:
                    rate = Decimal(0)  # nothing was set to recount: the old base just has no rate yet
                else:
                    with localcontext() as short:
                        short.prec = 12  # plenty for a rate, and readable in the rate field
                        rate = Decimal(row["rate"]) / factor
                c.update("currencies", row["code"], {"rate": dec_str(rate.normalize())})
            # The cushion target keeps its value: recount it into the new currency (it is 0 when there is no factor).
            target = (Decimal(int(cfg["cushion_target"])).scaleb(-old_decimals) / factor).scaleb(new["decimals"]) \
                if factor else Decimal(0)
        c.update("config", "cushion_target",
                 {"value": str(int(target.to_integral_value(rounding=ROUND_HALF_UP)))})
        c.update("config", "base_currency", {"value": new["code"]})
        base = new["code"]
    if "cushion_target" in body:
        target = to_minor(body["cushion_target"] or "0", get_currency(c.conn, base)["decimals"], "Cushion target")
        if target < 0:
            raise ApiError("Cushion target can't be below zero")
        c.update("config", "cushion_target", {"value": str(target)})
    return {"ok": True}


# ---------- monthly payments ----------

def clean_recurring(conn, body, current=None):
    get = lambda key, default=None: body.get(key, current[key] if current else default)  # noqa: E731
    currency = get_currency(conn, as_code(get("currency")))
    amount = body.get("amount")
    if amount is None and current:
        amount = from_minor(current["amount"], get_currency(conn, current["currency"])["decimals"])
    values = {
        "name": as_str(get("name"), "Name", LIMITS["name"], required=True),
        "amount": to_minor(amount, currency["decimals"]),
        "currency": currency["code"],
        "category_id": as_id(get("category_id"), "Category"),
        "wallet_id": as_id(get("wallet_id"), "Wallet"),
        "day": as_int(get("day", 1), "Day of the month", 1, 31),
        "is_active": int(as_bool(get("is_active", True), "Active")),
    }
    if values["amount"] <= 0:
        raise ApiError("Amount must be above zero")
    if values["category_id"] is not None and (not current or values["category_id"] != current["category_id"]):
        category = get_live(conn, "categories", values["category_id"], "Category")
        if category["kind"] != "expense":
            raise ApiError("Pick an expense category")
    if values["wallet_id"] is not None and (not current or values["wallet_id"] != current["wallet_id"]):
        if get_live(conn, "wallets", values["wallet_id"], "Wallet")["type"] == "debt":
            raise ApiError("Pick one of your wallets, not a debt")
    return values


def create_recurring(c, body):
    values = clean_recurring(c.conn, body)
    return {"ok": True, "id": c.insert("recurring", {**values, "created": now()})}


def update_recurring(c, item_id, body):
    current = get_live(c.conn, "recurring", item_id, "Monthly payment")
    c.update("recurring", item_id, clean_recurring(c.conn, body, current))
    return {"ok": True}


def delete_recurring(c, item_id):
    get_live(c.conn, "recurring", item_id, "Monthly payment")
    c.update("recurring", item_id, {"is_deleted": 1})
    return {"ok": True}


def spend(c, body, default_wallet, default_amount_minor, default_currency, category_id, note, **links):
    """An expense from one wallet: the Pay and Bought buttons. The amount is in the wallet's currency;
    when it isn't given, the planned amount is used if the currencies match."""
    wallet_id = as_id(body.get("wallet_id"), "Wallet") or default_wallet
    if wallet_id is None:
        raise ApiError("Pick a wallet to pay from")
    wallet = wallet_with_currency(c.conn, wallet_id)
    if wallet is None or wallet["is_deleted"]:
        raise ApiError("Wallet not found")
    amount = body.get("amount")
    if amount in (None, ""):
        if wallet["currency"] != default_currency:
            raise ApiError(f"Enter the amount in {wallet['currency']}")
        minor = default_amount_minor
    else:
        minor = to_minor(amount, wallet["decimals"])
    if minor <= 0:
        raise ApiError("Amount must be above zero")
    if "category_id" in body:
        category_id = as_id(body["category_id"], "Category")
    entries = clean_entries(c.conn, [{"wallet_id": wallet_id, "amount": from_minor(-minor, wallet["decimals"]),
                                      "category_id": category_id,
                                      "description": body.get("description", "")}], "expense")
    return insert_transaction(c, "expense", as_date(body.get("date") or today(), "Date"),
                              as_str(body.get("note", note), "Note", LIMITS["note"]), entries, **links)


def pay_recurring(c, item_id, body):
    item = get_live(c.conn, "recurring", item_id, "Monthly payment")
    tx_id = spend(c, body, item["wallet_id"], item["amount"], item["currency"], item["category_id"], item["name"],
                  recurring_id=item_id)
    return {"ok": True, "id": tx_id}


# ---------- plans and their savings ----------

def clean_planned(conn, body, current=None):
    get = lambda key, default=None: body.get(key, current[key] if current else default)  # noqa: E731
    currency = get_currency(conn, as_code(get("currency")))
    amount = body.get("amount")
    if amount is None and current:
        amount = from_minor(current["amount"], get_currency(conn, current["currency"])["decimals"])
    values = {
        "name": as_str(get("name"), "Name", LIMITS["name"], required=True),
        "amount": to_minor(amount, currency["decimals"]),
        "currency": currency["code"],
        "category_id": as_id(get("category_id"), "Category"),
        "priority": as_choice(get("priority", "medium"), "Priority", PRIORITIES),
        "due": as_date(get("due"), "Due date", required=False),
        "notes": as_str(get("notes", ""), "Notes", LIMITS["plan_notes"]),
    }
    if values["amount"] <= 0:
        raise ApiError("Amount must be above zero")
    if values["category_id"] is not None and (not current or values["category_id"] != current["category_id"]):
        if get_live(conn, "categories", values["category_id"], "Category")["kind"] != "expense":
            raise ApiError("Pick an expense category")
    if current and values["currency"] != current["currency"] and saved_minor(conn, current["id"]):
        raise ApiError("Money is already saved for this plan in its currency: take it back first")
    return values


def saved_minor(conn, planned_id):
    return conn.execute("SELECT COALESCE(SUM(amount), 0) FROM plan_savings WHERE planned_id = ?",
                        (planned_id,)).fetchone()[0]


def create_planned(c, body):
    values = clean_planned(c.conn, body)
    return {"ok": True, "id": c.insert("planned", {**values, "status": "open", "created": now()})}


def update_planned(c, item_id, body):
    current = get_live(c.conn, "planned", item_id, "Plan")
    values = clean_planned(c.conn, body, current)
    if "status" in body:
        values["status"] = as_choice(body["status"], "Status", PLAN_STATUSES)
        if values["status"] == "open":
            values["done_at"] = None
        elif values["status"] != current["status"]:
            values["done_at"] = today()
    c.update("planned", item_id, values)
    return {"ok": True}


def delete_planned(c, item_id):
    get_live(c.conn, "planned", item_id, "Plan")
    c.update("planned", item_id, {"is_deleted": 1})
    return {"ok": True}


def save_for_plan(c, item_id, body):
    """Put money aside for a plan (or take it back, below zero). The money stays in its wallets:
    this only marks it as taken, so it no longer counts as free."""
    plan = get_live(c.conn, "planned", item_id, "Plan")
    if plan["status"] != "open":
        raise ApiError("This plan is closed")
    decimals = get_currency(c.conn, plan["currency"])["decimals"]
    amount = to_minor(body.get("amount"), decimals)
    if not amount:
        raise ApiError("Amount can't be zero")
    saved = saved_minor(c.conn, item_id)
    if saved + amount < 0:
        raise ApiError(f"Only {from_minor(saved, decimals)} {plan['currency']} is saved for this plan")
    c.insert("plan_savings", {"planned_id": item_id, "date": as_date(body.get("date") or today(), "Date"),
                              "amount": amount, "note": as_str(body.get("note"), "Note", LIMITS["note"]),
                              "created": now()})
    return {"ok": True, "saved": from_minor(saved + amount, decimals)}


def buy_planned(c, item_id, body):
    plan = get_live(c.conn, "planned", item_id, "Plan")
    if plan["status"] != "open":
        raise ApiError("This plan is closed")
    tx_id = spend(c, body, None, plan["amount"], plan["currency"], plan["category_id"], plan["name"],
                  planned_id=item_id)
    c.update("planned", item_id, {"status": "done", "done_at": as_date(body.get("date") or today(), "Date")})
    return {"ok": True, "id": tx_id}


def drop_planned(c, item_id):
    plan = get_live(c.conn, "planned", item_id, "Plan")
    if plan["status"] != "open":
        raise ApiError("This plan is closed")
    c.update("planned", item_id, {"status": "dropped", "done_at": today()})
    return {"ok": True}


def plan_savings_list(conn, item_id):
    plan = get_live(conn, "planned", item_id, "Plan")
    decimals = get_currency(conn, plan["currency"])["decimals"]
    return {"savings": [{"id": r["id"], "date": r["date"], "amount": from_minor(r["amount"], decimals), "note": r["note"]}
                        for r in conn.execute("SELECT * FROM plan_savings WHERE planned_id = ? ORDER BY date DESC, id DESC",
                                              (item_id,))]}


# ---------- reports ----------

def flows(conn, date_from, date_to, by_month=False):
    """Income and spending by category: rows of (month?, category_id, kind, currency, total in minor units).
    A line counts as spending when its category is an expense one, or when it is an expense without a category;
    the same for income. Transfers, debts and balance checks without a category don't count."""
    month = "substr(t.date, 1, 7)" if by_month else "''"
    return conn.execute(f"""
        SELECT {month} AS month, e.category_id, COALESCE(c.kind, t.type) AS kind, w.currency, SUM(e.amount) AS total
        FROM entries e
        JOIN transactions t ON t.id = e.transaction_id AND t.is_deleted = 0
        JOIN wallets w ON w.id = e.wallet_id
        LEFT JOIN categories c ON c.id = e.category_id
        WHERE t.date BETWEEN ? AND ?
          AND (e.category_id IS NOT NULL OR t.type IN ('expense', 'income'))
        GROUP BY {month}, e.category_id, COALESCE(c.kind, t.type), w.currency""", (date_from, date_to)).fetchall()


def month_bounds(day):
    first = day[:8] + "01"
    year, month = int(day[:4]), int(day[5:7])
    nxt = date(year + month // 12, month % 12 + 1, 1)
    return first, date.fromordinal(nxt.toordinal() - 1).isoformat()


def shift_month(month, delta):
    """"2026-11", -1 -> "2026-10"."""
    year, m = int(month[:4]), int(month[5:7]) - 1 + delta
    return f"{year + m // 12:04d}-{m % 12 + 1:02d}"


def get_report(conn, query):
    """Spending by category and income by source for a period, plus income and spending for the 12 months
    up to the period's end. All in the base currency at the current rates."""
    date_to = as_date(query.get("to") or today(), "To")
    date_from = as_date(query.get("from") or date_to[:8] + "01", "From")
    if date_from > date_to:
        raise ApiError("The period starts after it ends")
    rates = Rates(conn)
    categories = {row["id"]: row for row in conn.execute("SELECT * FROM categories")}

    sums = {"expense": {}, "income": {}}
    for row in flows(conn, date_from, date_to):
        sign = -1 if row["kind"] == "expense" else 1
        bucket = sums[row["kind"]]
        bucket[row["category_id"]] = bucket.get(row["category_id"], 0) + sign * rates.to_base(row["total"], row["currency"])

    def tree(kind):
        groups = {}
        for category_id, total in sums[kind].items():
            category = categories.get(category_id)
            top = category if category is None or category["parent_id"] is None else categories[category["parent_id"]]
            top_id = top["id"] if top else None
            group = groups.setdefault(top_id, {
                "id": top_id, "name": top["name"] if top else "No category",
                "color": top["color"] if top else OTHER_COLOR, "is_deleted": bool(top and top["is_deleted"]),
                "total": 0, "items": [],
            })
            group["total"] += total
            if category is not None:
                group["items"].append({"id": category_id, "name": category["name"], "own": category is top,
                                       "is_deleted": bool(category["is_deleted"]), "total": total})
        out = sorted(groups.values(), key=lambda g: -g["total"])
        for group in out:
            group["items"].sort(key=lambda i: (-i["total"]))
            if len(group["items"]) == 1 and group["items"][0]["own"]:
                group["items"] = []  # no subcategories: nothing to unfold
            for item in group["items"]:
                item["total"] = rates.fmt_base(item["total"])
            group["total"] = rates.fmt_base(group["total"])
        return {"total": rates.fmt_base(sum(sums[kind].values())), "groups": out}

    last = date_to[:7]
    first = shift_month(last, -11)
    months = {shift_month(first, n): {"income": 0, "expense": 0} for n in range(12)}
    for row in flows(conn, first + "-01", month_bounds(date_to)[1], by_month=True):
        if row["month"] in months:
            sign = -1 if row["kind"] == "expense" else 1
            months[row["month"]][row["kind"]] += sign * rates.to_base(row["total"], row["currency"])
    return {
        "from": date_from, "to": date_to, "base": rates.base,
        "expense": tree("expense"), "income": tree("income"),
        "months": [{"month": m, "income": rates.fmt_base(v["income"]), "expense": rates.fmt_base(v["expense"])}
                   for m, v in months.items()],
    }


# ---------- state: everything the UI shows at start ----------

def get_state(conn, day=None):
    day = day or today()
    rates = Rates(conn)
    cfg = config(conn)
    base = rates.base
    balances = wallet_balances(conn)
    month_from, month_to = month_bounds(day)

    currencies = [{
        "code": r["code"], "name": r["name"], "kind": r["kind"], "decimals": r["decimals"],
        "rate": r["rate"], "rate_updated": r["rate_updated"], "used": currency_used(conn, r["code"]),
    } for r in conn.execute("SELECT * FROM currencies ORDER BY code = ? DESC, kind, code", (base,))]

    with_entries = {row[0] for row in conn.execute("SELECT DISTINCT wallet_id FROM entries")}
    wallets = []
    totals_by_type = {t: 0 for t in WALLET_TYPES}
    owed_to_me = i_owe = cushion = 0
    has_cushion_wallets = False
    for r in conn.execute("SELECT * FROM wallets WHERE is_deleted = 0 ORDER BY is_archived, id"):
        balance = balances.get(r["id"], 0)
        in_base = rates.to_base(balance, r["currency"])
        wallets.append({
            "id": r["id"], "name": r["name"], "type": r["type"], "currency": r["currency"], "color": r["color"],
            "note": r["note"], "is_cushion": bool(r["is_cushion"]), "is_archived": bool(r["is_archived"]),
            "created": r["created"], "balance": rates.fmt(balance, r["currency"]),
            "balance_base": rates.fmt_base(in_base), "has_transactions": r["id"] in with_entries,
        })
        if r["type"] == "debt":
            if in_base > 0:
                owed_to_me += in_base
            else:
                i_owe -= in_base
        else:
            totals_by_type[r["type"]] += in_base
            if r["is_cushion"]:
                has_cushion_wallets = True
                cushion += in_base
    money = sum(totals_by_type[t] for t in MONEY_TYPES)

    entry_counts = dict(conn.execute("""SELECT e.category_id, COUNT(*) FROM entries e
        JOIN transactions t ON t.id = e.transaction_id AND t.is_deleted = 0
        WHERE e.category_id IS NOT NULL GROUP BY e.category_id""").fetchall())
    category_rows = conn.execute("SELECT * FROM categories ORDER BY kind, id").fetchall()
    by_id = {r["id"]: r for r in category_rows}
    categories = [{
        "id": r["id"], "name": r["name"], "kind": r["kind"], "parent_id": r["parent_id"],
        "path": r["name"] if r["parent_id"] is None else f"{by_id[r['parent_id']]['name']}:{r['name']}",
        "color": r["color"] if r["parent_id"] is None else by_id[r["parent_id"]]["color"],
        "is_active": bool(r["is_active"]), "is_deleted": bool(r["is_deleted"]),
        "count": entry_counts.get(r["id"], 0),
    } for r in category_rows]

    paid = {row["recurring_id"]: row for row in conn.execute(
        """SELECT recurring_id, MAX(id) AS id, MAX(date) AS date FROM transactions
           WHERE is_deleted = 0 AND recurring_id IS NOT NULL AND date BETWEEN ? AND ?
           GROUP BY recurring_id""", (month_from, month_to))}
    recurring = []
    monthly_required = monthly_paid = 0
    for r in conn.execute("SELECT * FROM recurring WHERE is_deleted = 0 ORDER BY day, id"):
        in_base = rates.to_base(r["amount"], r["currency"])
        paid_tx = paid.get(r["id"])
        recurring.append({
            "id": r["id"], "name": r["name"], "amount": rates.fmt(r["amount"], r["currency"]),
            "currency": r["currency"], "amount_base": rates.fmt_base(in_base), "category_id": r["category_id"],
            "wallet_id": r["wallet_id"], "day": r["day"], "is_active": bool(r["is_active"]),
            "paid_tx_id": paid_tx["id"] if paid_tx else None, "paid_date": paid_tx["date"] if paid_tx else None,
        })
        if r["is_active"]:
            monthly_required += in_base
            if paid_tx:
                monthly_paid += in_base

    planned = []
    planned_total = planned_saved = planned_missing = 0
    for r in conn.execute("""SELECT p.*, COALESCE(SUM(s.amount), 0) AS saved FROM planned p
                             LEFT JOIN plan_savings s ON s.planned_id = p.id
                             WHERE p.is_deleted = 0 GROUP BY p.id
                             ORDER BY p.status = 'open' DESC, CASE p.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                                      p.due IS NULL, p.due, p.id"""):
        amount_base = rates.to_base(r["amount"], r["currency"])
        saved_base = rates.to_base(r["saved"], r["currency"])
        planned.append({
            "id": r["id"], "name": r["name"], "amount": rates.fmt(r["amount"], r["currency"]),
            "currency": r["currency"], "amount_base": rates.fmt_base(amount_base),
            "saved": rates.fmt(r["saved"], r["currency"]), "saved_base": rates.fmt_base(saved_base),
            "category_id": r["category_id"], "priority": r["priority"], "due": r["due"], "notes": r["notes"],
            "status": r["status"], "created": r["created"], "done_at": r["done_at"],
            "purchase_tx_id": None,
        })
        if r["status"] == "open":
            planned_total += amount_base
            planned_saved += saved_base
            planned_missing += max(0, amount_base - saved_base)
    purchases = dict(conn.execute("""SELECT planned_id, MAX(id) FROM transactions
                                     WHERE is_deleted = 0 AND planned_id IS NOT NULL GROUP BY planned_id""").fetchall())
    for p in planned:
        p["purchase_tx_id"] = purchases.get(p["id"])

    month_flows = {"income": 0, "expense": 0}
    for row in flows(conn, month_from, month_to):
        sign = -1 if row["kind"] == "expense" else 1
        month_flows[row["kind"]] += sign * rates.to_base(row["total"], row["currency"])

    target = int(cfg["cushion_target"])
    # Without wallets marked for the cushion, all your money counts toward it.
    cushion_saved = cushion if has_cushion_wallets else money
    reserved = cushion_saved if has_cushion_wallets else min(max(target, 0), max(money, 0))
    used_codes = {w["currency"] for w in wallets} | {r["currency"] for r in recurring if r["is_active"]} | \
                 {p["currency"] for p in planned if p["status"] == "open"}
    missing_rates = sorted(c["code"] for c in currencies
                           if c["code"] in used_codes and c["code"] != base and Decimal(c["rate"]) == 0)
    totals = {
        "money": money,
        "by_type": {t: totals_by_type[t] for t in MONEY_TYPES},
        "owed_to_me": owed_to_me,
        "i_owe": i_owe,
        "net": money + owed_to_me - i_owe,
        "cushion_saved": cushion_saved,
        "cushion_target": target,
        "cushion_left": max(0, target - cushion_saved),
        "earmarked": planned_saved,
        "free": money - reserved - planned_saved,
        "month_income": month_flows["income"],
        "month_expense": month_flows["expense"],
        "monthly_required": monthly_required,
        "monthly_paid": monthly_paid,
        "monthly_left": monthly_required - monthly_paid,
        "planned_total": planned_total,
        "planned_saved": planned_saved,
        "planned_missing": planned_missing,
    }
    totals = {k: ({t: rates.fmt_base(v) for t, v in val.items()} if isinstance(val, dict) else rates.fmt_base(val))
              for k, val in totals.items()}
    totals["cushion_wallets"] = has_cushion_wallets
    totals["months_covered"] = (round(cushion_saved / monthly_required, 1) if monthly_required > 0 else None)
    totals["missing_rates"] = missing_rates
    return {
        "today": day, "month": day[:7],
        "config": {"base_currency": base, "cushion_target": rates.fmt_base(target)},
        "currencies": currencies, "wallets": wallets, "categories": categories,
        "recurring": recurring, "planned": planned, "totals": totals,
        "limits": LIMITS,
    }


# ---------- export ----------

def export_json(conn):
    """Everything, readable: amounts in ordinary units next to their currency."""
    decimals = {r["code"]: r["decimals"] for r in conn.execute("SELECT code, decimals FROM currencies")}
    wallet_currency = {r["id"]: r["currency"] for r in conn.execute("SELECT id, currency FROM wallets")}
    rows = lambda sql: [dict(r) for r in conn.execute(sql)]  # noqa: E731
    data = {
        "exported": now(), "schema_version": conn.execute("PRAGMA user_version").fetchone()[0],
        "config": config(conn),
        "currencies": rows("SELECT * FROM currencies ORDER BY code"),
        "wallets": rows("SELECT * FROM wallets ORDER BY id"),
        "categories": rows("SELECT * FROM categories ORDER BY id"),
        "recurring": rows("SELECT * FROM recurring ORDER BY id"),
        "planned": rows("SELECT * FROM planned ORDER BY id"),
        "plan_savings": rows("SELECT * FROM plan_savings ORDER BY id"),
        "transactions": rows("SELECT * FROM transactions ORDER BY date, id"),
        "entries": rows("SELECT * FROM entries ORDER BY id"),
    }
    for table in ("recurring", "planned"):
        for item in data[table]:
            item["amount"] = from_minor(item["amount"], decimals[item["currency"]])
    plan_currency = {p["id"]: p["currency"] for p in data["planned"]}
    for item in data["plan_savings"]:
        item["amount"] = from_minor(item["amount"], decimals[plan_currency[item["planned_id"]]])
    for item in data["entries"]:
        item["currency"] = wallet_currency[item["wallet_id"]]
        item["amount"] = from_minor(item["amount"], decimals[item["currency"]])
    data["config"]["cushion_target"] = from_minor(int(data["config"]["cushion_target"]),
                                                  decimals[data["config"]["base_currency"]])
    return data


def export_csv(conn):
    """One row per transaction line, for a spreadsheet."""
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["date", "type", "wallet", "currency", "amount", "category", "description", "note", "transaction_id"])
    categories = {r["id"]: r for r in conn.execute("SELECT * FROM categories")}
    for r in conn.execute("""SELECT t.id, t.date, t.type, t.note, e.amount, e.category_id, e.description,
                                    w.name AS wallet, w.currency, c.decimals
                             FROM entries e JOIN transactions t ON t.id = e.transaction_id AND t.is_deleted = 0
                             JOIN wallets w ON w.id = e.wallet_id JOIN currencies c ON c.code = w.currency
                             ORDER BY t.date, t.id, e.id"""):
        category = categories.get(r["category_id"])
        writer.writerow([r["date"], r["type"], r["wallet"], r["currency"], from_minor(r["amount"], r["decimals"]),
                         category_path(conn, category) if category else "", r["description"], r["note"], r["id"]])
    return out.getvalue()
