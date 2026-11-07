"""A starter set of currencies and categories for tests (a new database has only USD)."""
import db

CURRENCIES = [
    ("EUR", "Euro", "fiat", 2),
    ("RUB", "Russian ruble", "fiat", 2),
    ("BTC", "Bitcoin", "crypto", 8),
    ("ETH", "Ether", "crypto", 8),
    ("USDT", "Tether", "crypto", 6),
]
CATEGORIES = {
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


def seed(conn):
    """Add the starter set to a fresh database, in one transaction."""
    conn.execute("BEGIN IMMEDIATE")
    for code, name, kind, decimals in CURRENCIES:
        conn.execute("INSERT INTO currencies (code, name, kind, decimals, rate) VALUES (?, ?, ?, ?, '0')",
                     (code, name, kind, decimals))
    for kind, tree in CATEGORIES.items():
        for n, (name, subs) in enumerate(tree):
            color = db.PALETTE[n] if n < len(db.PALETTE) and name != "Fees" else db.OTHER_COLOR
            parent = conn.execute("INSERT INTO categories (name, kind, color) VALUES (?, ?, ?)",
                                  (name, kind, color)).lastrowid
            for sub in subs:
                conn.execute("INSERT INTO categories (name, kind, parent_id, color) VALUES (?, ?, ?, ?)",
                             (sub, kind, parent, color))
    conn.execute("COMMIT")
