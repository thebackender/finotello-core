"""Tests for db.py on a fresh temporary database. Run: python3 -m unittest discover tests"""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402
import fixtures  # noqa: E402
from db import ApiError  # noqa: E402

DAY = "2026-11-07"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "finance.db"
        self.db = db.Database(self.path)
        fixtures.seed(self.db.conn)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    # helpers
    def w(self, fn, *args):
        return self.db.write(fn, *args)

    def state(self):
        return self.db.read(db.get_state, DAY)

    def wallet(self, name, currency="USD", type_="bank", **extra):
        return self.w(db.create_wallet, {"name": name, "currency": currency, "type": type_, **extra})["id"]

    def cat(self, path, kind="expense"):
        return self.w(db.create_category, {"kind": kind, "path": path})["id"]

    def tx(self, type_, entries, date=DAY, note=""):
        return self.w(db.create_transaction,
                      {"type": type_, "date": date, "note": note, "entries": entries})["id"]

    def balance(self, wallet_id):
        return next(w for w in self.state()["wallets"] if w["id"] == wallet_id)["balance"]

    def set_rate(self, code, rate):
        self.w(db.update_currency, code, {"rate": rate})


class Money(unittest.TestCase):
    def test_to_and_from_minor(self):
        self.assertEqual(db.to_minor("12.30", 2), 1230)
        self.assertEqual(db.to_minor("1 234,5", 2), 123450)
        self.assertEqual(db.to_minor("−500", 2), -50000)
        self.assertEqual(db.to_minor("0.00000001", 8), 1)
        self.assertEqual(db.from_minor(1230, 2), "12.30")
        self.assertEqual(db.from_minor(-5, 2), "-0.05")
        self.assertEqual(db.from_minor(1, 8), "0.00000001")
        self.assertEqual(db.from_minor(42, 0), "42")

    def test_too_many_decimals_is_an_error(self):
        with self.assertRaises(ApiError):
            db.to_minor("1.005", 2)
        with self.assertRaises(ApiError):
            db.to_minor("abc", 2)
        with self.assertRaises(ApiError):
            db.to_minor("1e20", 2)


class Seed(Base):
    def test_fresh_database(self):
        fresh = db.Database(Path(self.tmp.name) / "fresh.db")
        try:
            state = fresh.read(db.get_state, DAY)
            self.assertEqual(state["config"]["base_currency"], "USD")
            self.assertEqual([c["code"] for c in state["currencies"]], ["USD"])  # only the base currency
            self.assertEqual(state["categories"], [])
        finally:
            fresh.close()
        self.assertEqual(self.db.conn.execute("PRAGMA user_version").fetchone()[0], len(db.MIGRATIONS))

    def test_old_database_is_migrated(self):
        old = Path(self.tmp.name) / "old.db"
        conn = sqlite3.connect(old, isolation_level=None)
        db.migration_1(conn)
        conn.execute("CREATE TABLE undo_log (id INTEGER PRIMARY KEY, batch INTEGER)")  # as version 1 had it
        conn.execute("PRAGMA user_version = 1")
        conn.execute("INSERT INTO recurring (name, amount, currency, created) VALUES ('Rent', 80000, 'USD', 'x')")
        conn.close()
        backups = Path(self.tmp.name) / "backups"
        upgraded = db.Database(old, migration_backup_dir=backups)
        try:
            self.assertEqual(upgraded.conn.execute("PRAGMA user_version").fetchone()[0], len(db.MIGRATIONS))
            copy = next(backups.glob("finance-before-v*.db"))  # the old file was saved first
            self.assertEqual(sqlite3.connect(copy).execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertEqual(upgraded.read(db.get_state, DAY)["recurring"][0]["is_variable"], False)
            self.assertIsNone(upgraded.conn.execute(
                "SELECT 1 FROM sqlite_master WHERE name = 'undo_log'").fetchone())  # migration 3 dropped it
            self.assertEqual(upgraded.read(db.get_state, DAY)["config"]["report_from"], "")  # migration 4
            self.assertEqual(upgraded.read(db.get_state, DAY)["templates"], [])  # migration 5
            self.assertIsNone(upgraded.conn.execute(
                "SELECT 1 FROM sqlite_master WHERE name = 'plan_savings'").fetchone())  # migration 6 dropped it
        finally:
            upgraded.close()

    def test_reopen_keeps_data_and_version(self):
        self.wallet("Card")
        self.db.close()
        self.db = db.Database(self.path)
        self.assertEqual(len(self.state()["wallets"]), 1)


class Wallets(Base):
    def test_starting_balance_and_expense(self):
        card = self.wallet("Card", balance="1000")
        food = self.cat("Food:Fruits")
        self.tx("expense", [{"wallet_id": card, "amount": "-12.50", "category_id": food, "description": "apples"}])
        self.assertEqual(self.balance(card), "987.50")

    def test_split_receipt(self):
        card = self.wallet("Card", currency="RUB", balance="5000")
        fruits, dairy = self.cat("Food:Fruits"), self.cat("Food:Dairy")
        home = self.cat("Household:Cleaning")
        tx_id = self.tx("expense", [
            {"wallet_id": card, "amount": "-1200", "category_id": fruits, "description": "apples, bananas"},
            {"wallet_id": card, "amount": "-600", "category_id": dairy, "description": "milk, cheese"},
            {"wallet_id": card, "amount": "-2000", "category_id": home, "description": "detergent"},
        ], note="Auchan")
        self.assertEqual(self.balance(card), "1200.00")
        found = self.db.read(db.list_transactions, {"q": "CHEESE"})["transactions"]
        self.assertEqual([t["id"] for t in found], [tx_id])
        self.assertEqual(len(found[0]["entries"]), 3)
        self.assertEqual(self.db.read(db.list_transactions, {"q": "auchan"})["transactions"][0]["id"], tx_id)

    def test_expense_rules(self):
        card = self.wallet("Card")
        salary = self.cat("Salary", "income")
        with self.assertRaises(ApiError):  # positive expense
            self.tx("expense", [{"wallet_id": card, "amount": "10"}])
        with self.assertRaises(ApiError):  # income category on an expense
            self.tx("expense", [{"wallet_id": card, "amount": "-10", "category_id": salary}])
        with self.assertRaises(ApiError):  # zero
            self.tx("expense", [{"wallet_id": card, "amount": "0"}])
        with self.assertRaises(ApiError):  # no such wallet
            self.tx("expense", [{"wallet_id": 999, "amount": "-1"}])

    def test_delete_only_without_transactions(self):
        card = self.wallet("Card", balance="1")
        with self.assertRaises(ApiError):
            self.w(db.delete_wallet, card)
        empty = self.wallet("Empty")
        self.w(db.delete_wallet, empty)
        self.assertEqual([w["id"] for w in self.state()["wallets"]], [card])

    def test_fix_currency_picked_by_mistake(self):
        card = self.wallet("Card", balance="1000")  # meant to be RUB
        self.tx("expense", [{"wallet_id": card, "amount": "-12.50"}])
        self.w(db.update_wallet, card, {"currency": "RUB"})
        self.assertEqual(self.balance(card), "987.50")
        self.w(db.update_wallet, card, {"currency": "BTC"})  # more decimals: amounts scale up
        self.assertEqual(self.balance(card), "987.50000000")

    def test_currency_fixed_when_shared_with_other_wallets(self):
        card, cash = self.wallet("Card", balance="100"), self.wallet("Cash")
        self.tx("transfer", [{"wallet_id": card, "amount": "-50"}, {"wallet_id": cash, "amount": "50"}])
        with self.assertRaises(ApiError):
            self.w(db.update_wallet, card, {"currency": "EUR"})

    def test_currency_with_fewer_decimals_must_fit(self):
        coins = self.wallet("Coins", currency="BTC", balance="0.5")
        self.w(db.update_wallet, coins, {"currency": "RUB"})
        self.assertEqual(self.balance(coins), "0.50")
        odd = self.wallet("Odd", currency="BTC", balance="0.123")
        with self.assertRaises(ApiError):
            self.w(db.update_wallet, odd, {"currency": "USD"})

    def test_names_are_unique(self):
        self.wallet("Card")
        with self.assertRaises(ApiError):
            self.wallet("card")


class Transfers(Base):
    def test_same_currency_must_match(self):
        a, b = self.wallet("A", balance="100"), self.wallet("B")
        with self.assertRaises(ApiError):
            self.tx("transfer", [{"wallet_id": a, "amount": "-50"}, {"wallet_id": b, "amount": "40"}])
        self.tx("transfer", [{"wallet_id": a, "amount": "-50"}, {"wallet_id": b, "amount": "50"}])
        self.assertEqual((self.balance(a), self.balance(b)), ("50.00", "50.00"))

    def test_exchange_with_fee_in_satoshi(self):
        usdt = self.wallet("Binance USDT", currency="USDT", type_="crypto", balance="1000")
        btc = self.wallet("Binance BTC", currency="BTC", type_="crypto")
        fees = self.cat("Fees")
        self.tx("transfer", [
            {"wallet_id": usdt, "amount": "-990"},
            {"wallet_id": btc, "amount": "0.01052631"},
            {"wallet_id": usdt, "amount": "-1.5", "category_id": fees},
        ])
        self.assertEqual(self.balance(usdt), "8.500000")
        self.assertEqual(self.balance(btc), "0.01052631")
        self.set_rate("BTC", "95000")
        self.set_rate("USDT", "1")
        state = self.state()
        btc_row = next(w for w in state["wallets"] if w["id"] == btc)
        self.assertEqual(btc_row["balance_base"], "1000.00")  # 0.01052631 * 95000 = 999.99945
        # the fee shows up as spending
        report = self.db.read(db.get_report, {"from": "2026-11-01", "to": "2026-11-30"})
        self.assertEqual(report["expense"]["total"], "1.50")

    def test_transfer_to_person_is_a_debt(self):
        card = self.wallet("Card", balance="100")
        ivan = self.wallet("Ivan", type_="debt")
        with self.assertRaises(ApiError):
            self.tx("transfer", [{"wallet_id": card, "amount": "-10"}, {"wallet_id": ivan, "amount": "10"}])


class Debts(Base):
    def test_lend_and_partial_return(self):
        card = self.wallet("Card", currency="RUB", balance="20000")
        ivan = self.wallet("Ivan", currency="RUB", type_="debt")
        self.set_rate("RUB", "0.01")
        self.tx("debt", [{"wallet_id": card, "amount": "-10000"}, {"wallet_id": ivan, "amount": "10000"}])
        self.tx("debt", [{"wallet_id": ivan, "amount": "-4000"}, {"wallet_id": card, "amount": "4000"}])
        self.assertEqual(self.balance(ivan), "6000.00")
        totals = self.state()["totals"]
        self.assertEqual(totals["money"], "140.00")
        self.assertEqual(totals["owed_to_me"], "60.00")
        self.assertEqual(totals["net"], "200.00")

    def test_friend_paid_for_me(self):
        petya = self.wallet("Petya", type_="debt")
        cafe = self.cat("Food:Eating out")
        self.tx("expense", [{"wallet_id": petya, "amount": "-15", "category_id": cafe}])
        totals = self.state()["totals"]
        self.assertEqual(totals["i_owe"], "15.00")
        self.assertEqual(totals["money"], "0.00")
        self.assertEqual(totals["month_expense"], "15.00")

    def test_debt_cant_be_cushion(self):
        with self.assertRaises(ApiError):
            self.wallet("Ivan", type_="debt", is_cushion=True)


class Categories(Base):
    def test_path_creates_missing_parent(self):
        snack = self.cat("Treats:Snacks")
        state = self.state()
        row = next(c for c in state["categories"] if c["id"] == snack)
        self.assertEqual(row["path"], "Treats:Snacks")
        parent = next(c for c in state["categories"] if c["id"] == row["parent_id"])
        self.assertEqual(row["color"], parent["color"])
        self.assertEqual(self.w(db.create_category, {"kind": "expense", "path": "treats:snacks"})["id"], snack)

    def test_two_levels_only(self):
        with self.assertRaises(ApiError):
            self.cat("A:B:C")
        fruits = self.cat("Food:Fruits")
        with self.assertRaises(ApiError):
            self.w(db.create_category, {"kind": "expense", "name": "Apples", "parent_id": fruits})
        with self.assertRaises(ApiError):
            self.w(db.create_category, {"kind": "expense", "name": "A:B"})

    def test_report_rolls_up_subcategories(self):
        card = self.wallet("Card", balance="1000")
        food, fruits, dairy = self.cat("Food"), self.cat("Food:Fruits"), self.cat("Food:Dairy")
        self.tx("expense", [{"wallet_id": card, "amount": "-10", "category_id": fruits},
                            {"wallet_id": card, "amount": "-5", "category_id": dairy},
                            {"wallet_id": card, "amount": "-2", "category_id": food}])
        self.tx("expense", [{"wallet_id": card, "amount": "-1"}])  # no category
        salary = self.cat("Salary", "income")
        self.tx("income", [{"wallet_id": card, "amount": "300", "category_id": salary}])
        report = self.db.read(db.get_report, {"from": "2026-11-01", "to": "2026-11-30"})
        groups = {g["name"]: g for g in report["expense"]["groups"]}
        self.assertEqual(groups["Food"]["total"], "17.00")
        self.assertEqual({i["name"]: i["total"] for i in groups["Food"]["items"]},
                         {"Fruits": "10.00", "Dairy": "5.00", "Food": "2.00"})
        self.assertEqual(groups["No category"]["total"], "1.00")
        self.assertEqual(report["expense"]["total"], "18.00")
        self.assertEqual(report["income"]["total"], "300.00")
        self.assertEqual(report["months"][-1], {"month": "2026-11", "income": "300.00", "expense": "18.00"})
        self.assertEqual(len(report["months"]), 12)
        found = self.db.read(db.list_transactions, {"category": str(food)})["transactions"]
        self.assertEqual(len(found), 1)

    def test_merge_moves_lines_and_subcategories(self):
        card = self.wallet("Card", balance="100")
        old_fruit = self.cat("Groceries2:Fruits")
        old_meat = self.cat("Groceries2:Meat")
        food_fruits = self.cat("Food:Fruits")
        self.tx("expense", [{"wallet_id": card, "amount": "-3", "category_id": old_fruit},
                            {"wallet_id": card, "amount": "-4", "category_id": old_meat}])
        state = self.state()
        groceries2 = next(c for c in state["categories"] if c["path"] == "Groceries2")["id"]
        food = next(c for c in state["categories"] if c["path"] == "Food")["id"]
        self.w(db.merge_category, groceries2, {"into": food})
        lines = self.db.read(db.list_transactions, {})["transactions"][0]["entries"]
        meat = next(c for c in self.state()["categories"] if c["path"] == "Food:Meat")
        self.assertEqual(sorted(e["category_id"] for e in lines), sorted([food_fruits, meat["id"]]))

    def test_move_subcategory(self):
        fruits = self.cat("Food:Fruits")
        health = self.cat("Health")
        self.w(db.update_category, fruits, {"parent_id": health})
        self.assertEqual(next(c for c in self.state()["categories"] if c["id"] == fruits)["path"], "Health:Fruits")

    def test_delete_keeps_old_lines(self):
        card = self.wallet("Card", balance="10")
        fruits = self.cat("Food:Fruits")
        tx_id = self.tx("expense", [{"wallet_id": card, "amount": "-1", "category_id": fruits}])
        food = next(c for c in self.state()["categories"] if c["path"] == "Food")["id"]
        self.w(db.delete_category, food)
        cats = {c["id"]: c for c in self.state()["categories"]}
        self.assertTrue(cats[fruits]["is_deleted"])
        # editing the old transaction keeps its deleted category, a new one can't use it
        self.w(db.update_transaction, tx_id, {"note": "x", "entries": [
            {"wallet_id": card, "amount": "-2", "category_id": fruits}]})
        with self.assertRaises(ApiError):
            self.tx("expense", [{"wallet_id": card, "amount": "-1", "category_id": fruits}])


class Plans(Base):
    def test_monthly_payment(self):
        card = self.wallet("Card", balance="2000")
        rent = self.cat("Housing:Rent")
        item = self.w(db.create_recurring, {"name": "Rent", "amount": "800", "currency": "USD",
                                                   "category_id": rent, "wallet_id": card, "day": 5})["id"]
        state = self.state()
        self.assertEqual(state["totals"]["monthly_required"], "800.00")
        self.assertEqual(state["totals"]["monthly_left"], "800.00")
        self.w(db.pay_recurring, item, {"date": DAY})
        state = self.state()
        self.assertEqual(state["totals"]["monthly_left"], "0.00")
        self.assertIsNotNone(state["recurring"][0]["paid_tx_id"])
        self.assertEqual(self.balance(card), "1200.00")
        # last month's payment doesn't count for this month
        self.assertIsNone(self.db.read(db.get_state, "2026-12-01")["recurring"][0]["paid_tx_id"])

    def test_varying_payment_expects_average_of_last_payments(self):
        card = self.wallet("Card", balance="1000")
        util = self.w(db.create_recurring, {"name": "Utilities", "amount": "100", "currency": "USD",
                                                   "is_variable": True, "wallet_id": card})["id"]
        rec = lambda day=DAY: self.db.read(db.get_state, day)["recurring"][0]  # noqa: E731
        self.assertEqual((rec()["expected_base"], rec()["expected_from"]), ("100.00", 0))  # no payments yet
        for date, amount in [("2026-08-10", "80"), ("2026-09-10", "120"), ("2026-10-10", "90"), ("2026-11-10", "130")]:
            self.w(db.pay_recurring, util, {"date": date, "amount": amount})
        state = self.db.read(db.get_state, DAY)
        self.assertEqual(state["recurring"][0]["expected_base"], "113.33")  # (120 + 90 + 130) / 3
        self.assertEqual(state["recurring"][0]["expected"], "113.33")
        self.assertEqual(state["recurring"][0]["paid_base"], "130.00")
        self.assertEqual(state["totals"]["monthly_required"], "113.33")
        self.assertEqual(state["totals"]["monthly_paid"], "130.00")  # what was really paid
        self.assertEqual(state["totals"]["monthly_left"], "0.00")
        december = self.db.read(db.get_state, "2026-12-01")
        self.assertEqual(december["totals"]["monthly_left"], "113.33")

    def test_varying_payment_average_in_its_own_currency(self):
        card = self.wallet("Card RUB", currency="RUB", balance="100000")
        self.set_rate("RUB", "0.011")
        util = self.w(db.create_recurring, {"name": "Utilities", "amount": "6000", "currency": "RUB",
                                                   "is_variable": True, "wallet_id": card})["id"]
        for date, amount in [("2026-08-15", "5200"), ("2026-09-15", "5800"), ("2026-10-15", "7400")]:
            self.w(db.pay_recurring, util, {"date": date, "amount": amount})
        self.assertEqual(self.state()["recurring"][0]["expected"], "6133.33")  # no detour through the base currency

    def test_fixed_payment_counts_what_was_really_paid(self):
        card = self.wallet("Card", balance="2000")
        rent = self.w(db.create_recurring, {"name": "Rent", "amount": "800", "currency": "USD", "wallet_id": card})["id"]
        self.w(db.pay_recurring, rent, {"date": DAY, "amount": "850"})
        totals = self.state()["totals"]
        self.assertEqual((totals["monthly_required"], totals["monthly_paid"]), ("800.00", "850.00"))

    def test_pay_in_another_currency_needs_amount(self):
        card = self.wallet("Card RUB", currency="RUB", balance="100000")
        item = self.w(db.create_recurring, {"name": "Gym", "amount": "50", "currency": "USD"})["id"]
        with self.assertRaises(ApiError):
            self.w(db.pay_recurring, item, {"wallet_id": card})
        self.w(db.pay_recurring, item, {"wallet_id": card, "amount": "4600"})
        self.assertEqual(self.balance(card), "95400.00")

    def test_plan_and_buy(self):
        card = self.wallet("Card", balance="3000")
        reserve = self.wallet("Reserve", type_="bank", is_cushion=True, balance="1000")
        self.w(db.update_config, {"cushion_target": "2500"})
        dentist = self.cat("Health:Dentist")
        plan = self.w(db.create_planned, {"name": "Teeth", "amount": "1500", "currency": "USD",
                                                 "category_id": dentist})["id"]
        totals = self.state()["totals"]
        self.assertEqual(totals["cushion_saved"], "1000.00")
        self.assertEqual(totals["cushion_left"], "1500.00")
        self.assertEqual(totals["planned_total"], "1500.00")
        self.w(db.buy_planned, plan, {"wallet_id": card, "amount": "1450"})
        state = self.state()
        self.assertEqual(state["planned"][0]["status"], "done")
        self.assertEqual(state["totals"]["planned_total"], "0.00")
        self.assertEqual(self.balance(card), "1550.00")
        # deleting the purchase opens the plan again
        self.w(db.delete_transaction, state["planned"][0]["purchase_tx_id"])
        self.assertEqual(self.state()["planned"][0]["status"], "open")
        del reserve

    def test_cushion_without_marked_wallets_uses_all_money(self):
        self.wallet("Card", balance="700")
        self.w(db.update_config, {"cushion_target": "1000"})
        totals = self.state()["totals"]
        self.assertEqual(totals["cushion_saved"], "700.00")
        self.assertEqual(totals["cushion_left"], "300.00")


class Currencies(Base):
    def test_change_base_currency(self):
        self.set_rate("EUR", "1.25")
        self.set_rate("BTC", "100000")
        self.w(db.update_config, {"cushion_target": "1000"})
        self.w(db.update_config, {"base_currency": "EUR"})
        rates = {c["code"]: c["rate"] for c in self.state()["currencies"]}
        self.assertEqual(rates["EUR"], "1")
        self.assertEqual(rates["USD"], "0.8")
        self.assertEqual(rates["BTC"], "80000")
        self.assertEqual(self.state()["config"]["cushion_target"], "800.00")

    def test_switch_base_on_fresh_database(self):
        # No rates set yet: nothing to recount, so it just switches.
        self.w(db.update_config, {"base_currency": "RUB"})
        rates = {c["code"]: c["rate"] for c in self.state()["currencies"]}
        self.assertEqual((rates["RUB"], rates["USD"]), ("1", "0"))

    def test_switch_base_needs_its_rate_when_others_are_set(self):
        self.set_rate("EUR", "1.1")
        with self.assertRaises(ApiError):
            self.w(db.update_config, {"base_currency": "RUB"})
        self.w(db.update_config, {"base_currency": "RUB", "base_rate": "0.0125"})
        rates = {c["code"]: c["rate"] for c in self.state()["currencies"]}
        self.assertEqual((rates["RUB"], rates["USD"], rates["EUR"]), ("1", "80", "88"))

    def test_missing_rates_are_reported(self):
        self.wallet("Card", currency="EUR", balance="5")
        self.assertEqual(self.state()["totals"]["missing_rates"], ["EUR"])

    def test_report_period_is_kept(self):
        self.assertEqual(self.state()["config"]["report_from"], "")  # empty: the current month
        self.w(db.update_config, {"report_from": "2026-01-01", "report_to": "2026-03-31"})
        cfg = self.state()["config"]
        self.assertEqual((cfg["report_from"], cfg["report_to"]), ("2026-01-01", "2026-03-31"))
        with self.assertRaises(ApiError):
            self.w(db.update_config, {"report_from": "2026-04-01", "report_to": "2026-03-31"})
        with self.assertRaises(ApiError):
            self.w(db.update_config, {"report_from": "2026-02-30"})
        self.w(db.update_config, {"report_from": "", "report_to": ""})
        self.assertEqual(self.state()["config"]["report_to"], "")

    def test_cant_remove_used_currency(self):
        self.wallet("Card", currency="EUR")
        with self.assertRaises(ApiError):
            self.w(db.delete_currency, "EUR")
        self.w(db.delete_currency, "ETH")
        self.assertNotIn("ETH", [c["code"] for c in self.state()["currencies"]])


class Budgets(Base):
    def test_budget_counts_subcategories_this_month(self):
        card = self.wallet("Card", balance="1000")
        food, fruits = self.cat("Food"), self.cat("Food:Fruits")
        self.w(db.update_category, food, {"budget": "100"})
        self.tx("expense", [{"wallet_id": card, "amount": "-30", "category_id": fruits},
                            {"wallet_id": card, "amount": "-20", "category_id": food}])
        self.tx("expense", [{"wallet_id": card, "amount": "-500", "category_id": food}], date="2026-10-30")  # last month
        [budget] = self.state()["budgets"]
        self.assertEqual((budget["category_id"], budget["budget"], budget["spent"], budget["left"]),
                         (food, "100.00", "50.00", "50.00"))
        self.assertEqual(budget["share"], 0.5)
        self.w(db.update_category, food, {"budget": ""})
        self.assertEqual(self.state()["budgets"], [])

    def test_only_spending_categories_above_zero(self):
        salary = self.cat("Salary", kind="income")
        with self.assertRaises(ApiError):
            self.w(db.update_category, salary, {"budget": "100"})
        with self.assertRaises(ApiError):
            self.w(db.update_category, self.cat("Food"), {"budget": "-5"})

    def test_base_switch_recounts_budgets(self):
        food = self.cat("Food")
        self.w(db.update_category, food, {"budget": "110"})
        with self.assertRaises(ApiError):  # a budget needs recounting: the new base's rate is required
            self.w(db.update_config, {"base_currency": "EUR"})
        self.w(db.update_config, {"base_currency": "EUR", "base_rate": "1.1"})
        self.assertEqual(next(c for c in self.state()["categories"] if c["id"] == food)["budget"], "100.00")


class Templates(Base):
    def test_create_rename_delete(self):
        data = {"type": "expense", "note": "Coffee", "lines": [{"amount": "3.5", "category_id": None, "description": ""}]}
        tid = self.w(db.create_template, {"name": "Coffee", "data": data})["id"]
        [t] = self.state()["templates"]
        self.assertEqual((t["id"], t["name"], t["type"], t["data"]), (tid, "Coffee", "expense", data))
        self.w(db.update_template, tid, {"name": "Latte"})
        self.assertEqual(self.state()["templates"][0]["name"], "Latte")
        self.assertEqual(self.state()["templates"][0]["data"], data)
        self.w(db.delete_template, tid)
        self.assertEqual(self.state()["templates"], [])

    def test_checks(self):
        with self.assertRaises(ApiError):
            self.w(db.create_template, {"name": "X", "data": {"type": "adjustment"}})
        with self.assertRaises(ApiError):
            self.w(db.create_template, {"name": "", "data": {"type": "expense"}})
        with self.assertRaises(ApiError):
            self.w(db.create_template, {"name": "X", "data": "not a form"})


class History(Base):
    def test_month_end_balances_with_debts(self):
        card = self.wallet("Card")
        ivan = self.wallet("Ivan", type_="debt")
        self.tx("income", [{"wallet_id": card, "amount": "1000"}], date="2026-09-10")
        self.tx("debt", [{"wallet_id": card, "amount": "-300"}, {"wallet_id": ivan, "amount": "300"}], date="2026-11-02")
        history = self.state()["history"]
        self.assertEqual([h["month"] for h in history], ["2026-09", "2026-10", "2026-11"])
        self.assertEqual([h["money"] for h in history], ["1000.00", "1000.00", "700.00"])
        self.assertEqual([h["net"] for h in history], ["1000.00", "1000.00", "1000.00"])

    def test_empty(self):
        self.assertEqual(self.state()["history"], [])


class Integrity(Base):
    def test_failed_action_changes_nothing(self):
        card = self.wallet("Card", balance="100")
        with self.assertRaises(ApiError):
            self.tx("expense", [{"wallet_id": card, "amount": "-1"}, {"wallet_id": card, "amount": "5"}])
        self.assertEqual(self.balance(card), "100.00")
        self.assertEqual(len(self.db.read(db.list_transactions, {})["transactions"]), 1)  # only the starting balance

    def test_foreign_keys_are_on(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.conn.execute("INSERT INTO entries (transaction_id, wallet_id, amount) VALUES (999, 999, 1)")

    def test_backup_copy(self):
        self.wallet("Card", balance="5")
        target = Path(self.tmp.name) / "copy.db"
        self.db.backup_to(target)
        copy = db.Database(target)
        try:
            self.assertEqual(copy.read(db.get_state, DAY)["wallets"][0]["balance"], "5.00")
        finally:
            copy.close()

    def test_export(self):
        card = self.wallet("Card", currency="EUR", balance="5")
        self.tx("expense", [{"wallet_id": card, "amount": "-1.5", "description": 'a "quoted", line'}])
        data = self.db.read(db.export_json)
        self.assertEqual(data["entries"][-1]["amount"], "-1.50")
        text = self.db.read(db.export_csv)
        self.assertIn('"a ""quoted"", line"', text)


if __name__ == "__main__":
    unittest.main()
