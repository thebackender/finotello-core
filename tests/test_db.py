"""Tests for db.py on a fresh temporary database. Run: python3 -m unittest discover tests"""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402
from db import ApiError  # noqa: E402

DAY = "2026-11-07"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "finance.db"
        self.db = db.Database(self.path)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    # helpers
    def w(self, label, fn, *args):
        return self.db.write(label, fn, *args)

    def state(self):
        return self.db.read(db.get_state, DAY)

    def wallet(self, name, currency="USD", type_="bank", **extra):
        return self.w("Add wallet", db.create_wallet, {"name": name, "currency": currency, "type": type_, **extra})["id"]

    def cat(self, path, kind="expense"):
        return self.w("Add category", db.create_category, {"kind": kind, "path": path})["id"]

    def tx(self, type_, entries, date=DAY, note=""):
        return self.w("Add transaction", db.create_transaction,
                      {"type": type_, "date": date, "note": note, "entries": entries})["id"]

    def balance(self, wallet_id):
        return next(w for w in self.state()["wallets"] if w["id"] == wallet_id)["balance"]

    def set_rate(self, code, rate):
        self.w("Rate", db.update_currency, code, {"rate": rate})


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
        state = self.state()
        self.assertEqual(state["config"]["base_currency"], "USD")
        paths = {c["path"] for c in state["categories"]}
        self.assertIn("Food:Fruits", paths)
        self.assertIn("Salary", paths)
        self.assertEqual(self.db.conn.execute("PRAGMA user_version").fetchone()[0], len(db.MIGRATIONS))

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

    def test_reconcile(self):
        cash = self.wallet("Cash", type_="cash", balance="100")
        result = self.w("Check", db.reconcile_wallet, cash, {"balance": "93.40"})
        self.assertEqual(result["diff"], "-6.60")
        self.assertEqual(self.balance(cash), "93.40")
        self.assertEqual(self.w("Check", db.reconcile_wallet, cash, {"balance": "93.4"})["diff"], "0.00")

    def test_delete_only_without_transactions(self):
        card = self.wallet("Card", balance="1")
        with self.assertRaises(ApiError):
            self.w("Delete", db.delete_wallet, card)
        empty = self.wallet("Empty")
        self.w("Delete", db.delete_wallet, empty)
        self.assertEqual([w["id"] for w in self.state()["wallets"]], [card])

    def test_currency_locked_once_used(self):
        card = self.wallet("Card", balance="1")
        with self.assertRaises(ApiError):
            self.w("Edit", db.update_wallet, card, {"currency": "EUR"})

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
        self.assertEqual(self.w("Add", db.create_category, {"kind": "expense", "path": "treats:snacks"})["id"], snack)

    def test_two_levels_only(self):
        with self.assertRaises(ApiError):
            self.cat("A:B:C")
        fruits = self.cat("Food:Fruits")
        with self.assertRaises(ApiError):
            self.w("Add", db.create_category, {"kind": "expense", "name": "Apples", "parent_id": fruits})
        with self.assertRaises(ApiError):
            self.w("Add", db.create_category, {"kind": "expense", "name": "A:B"})

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
        self.w("Merge", db.merge_category, groceries2, {"into": food})
        lines = self.db.read(db.list_transactions, {})["transactions"][0]["entries"]
        meat = next(c for c in self.state()["categories"] if c["path"] == "Food:Meat")
        self.assertEqual(sorted(e["category_id"] for e in lines), sorted([food_fruits, meat["id"]]))
        self.db.undo()
        lines = self.db.read(db.list_transactions, {})["transactions"][0]["entries"]
        self.assertEqual(sorted(e["category_id"] for e in lines), sorted([old_fruit, old_meat]))

    def test_move_subcategory(self):
        fruits = self.cat("Food:Fruits")
        health = self.cat("Health")
        self.w("Move", db.update_category, fruits, {"parent_id": health})
        self.assertEqual(next(c for c in self.state()["categories"] if c["id"] == fruits)["path"], "Health:Fruits")

    def test_delete_keeps_old_lines(self):
        card = self.wallet("Card", balance="10")
        fruits = self.cat("Food:Fruits")
        tx_id = self.tx("expense", [{"wallet_id": card, "amount": "-1", "category_id": fruits}])
        food = next(c for c in self.state()["categories"] if c["path"] == "Food")["id"]
        self.w("Delete", db.delete_category, food)
        cats = {c["id"]: c for c in self.state()["categories"]}
        self.assertTrue(cats[fruits]["is_deleted"])
        # editing the old transaction keeps its deleted category, a new one can't use it
        self.w("Edit", db.update_transaction, tx_id, {"note": "x", "entries": [
            {"wallet_id": card, "amount": "-2", "category_id": fruits}]})
        with self.assertRaises(ApiError):
            self.tx("expense", [{"wallet_id": card, "amount": "-1", "category_id": fruits}])


class Plans(Base):
    def test_monthly_payment(self):
        card = self.wallet("Card", balance="2000")
        rent = self.cat("Housing:Rent")
        item = self.w("Add", db.create_recurring, {"name": "Rent", "amount": "800", "currency": "USD",
                                                   "category_id": rent, "wallet_id": card, "day": 5})["id"]
        state = self.state()
        self.assertEqual(state["totals"]["monthly_required"], "800.00")
        self.assertEqual(state["totals"]["monthly_left"], "800.00")
        self.w("Pay", db.pay_recurring, item, {"date": DAY})
        state = self.state()
        self.assertEqual(state["totals"]["monthly_left"], "0.00")
        self.assertIsNotNone(state["recurring"][0]["paid_tx_id"])
        self.assertEqual(self.balance(card), "1200.00")
        # last month's payment doesn't count for this month
        self.assertIsNone(self.db.read(db.get_state, "2026-12-01")["recurring"][0]["paid_tx_id"])

    def test_pay_in_another_currency_needs_amount(self):
        card = self.wallet("Card RUB", currency="RUB", balance="100000")
        item = self.w("Add", db.create_recurring, {"name": "Gym", "amount": "50", "currency": "USD"})["id"]
        with self.assertRaises(ApiError):
            self.w("Pay", db.pay_recurring, item, {"wallet_id": card})
        self.w("Pay", db.pay_recurring, item, {"wallet_id": card, "amount": "4600"})
        self.assertEqual(self.balance(card), "95400.00")

    def test_savings_buy_and_free_money(self):
        card = self.wallet("Card", balance="3000")
        reserve = self.wallet("Reserve", type_="bank", is_cushion=True, balance="1000")
        self.w("Target", db.update_config, {"cushion_target": "2500"})
        dentist = self.cat("Health:Dentist")
        plan = self.w("Add", db.create_planned, {"name": "Teeth", "amount": "1500", "currency": "USD",
                                                 "category_id": dentist})["id"]
        self.w("Save", db.save_for_plan, plan, {"amount": "600"})
        with self.assertRaises(ApiError):
            self.w("Save", db.save_for_plan, plan, {"amount": "-700"})
        totals = self.state()["totals"]
        self.assertEqual(totals["cushion_saved"], "1000.00")
        self.assertEqual(totals["cushion_left"], "1500.00")
        self.assertEqual(totals["planned_missing"], "900.00")
        self.assertEqual(totals["free"], "2400.00")  # 4000 - 1000 cushion - 600 saved
        self.w("Buy", db.buy_planned, plan, {"wallet_id": card, "amount": "1450"})
        state = self.state()
        self.assertEqual(state["planned"][0]["status"], "done")
        self.assertEqual(state["totals"]["earmarked"], "0.00")
        self.assertEqual(self.balance(card), "1550.00")
        # deleting the purchase opens the plan again
        self.w("Delete", db.delete_transaction, state["planned"][0]["purchase_tx_id"])
        self.assertEqual(self.state()["planned"][0]["status"], "open")
        del reserve

    def test_cushion_without_marked_wallets_uses_all_money(self):
        self.wallet("Card", balance="700")
        self.w("Target", db.update_config, {"cushion_target": "1000"})
        totals = self.state()["totals"]
        self.assertEqual(totals["cushion_saved"], "700.00")
        self.assertEqual(totals["cushion_left"], "300.00")
        self.assertEqual(totals["free"], "0.00")


class Currencies(Base):
    def test_change_base_currency(self):
        self.set_rate("EUR", "1.25")
        self.set_rate("BTC", "100000")
        self.w("Target", db.update_config, {"cushion_target": "1000"})
        self.w("Base", db.update_config, {"base_currency": "EUR"})
        rates = {c["code"]: c["rate"] for c in self.state()["currencies"]}
        self.assertEqual(rates["EUR"], "1")
        self.assertEqual(rates["USD"], "0.8")
        self.assertEqual(rates["BTC"], "80000")
        self.assertEqual(self.state()["config"]["cushion_target"], "800.00")

    def test_switch_base_on_fresh_database(self):
        # No rates set yet: nothing to recount, so it just switches.
        self.w("Base", db.update_config, {"base_currency": "RUB"})
        rates = {c["code"]: c["rate"] for c in self.state()["currencies"]}
        self.assertEqual((rates["RUB"], rates["USD"]), ("1", "0"))

    def test_switch_base_needs_its_rate_when_others_are_set(self):
        self.set_rate("EUR", "1.1")
        with self.assertRaises(ApiError):
            self.w("Base", db.update_config, {"base_currency": "RUB"})
        self.w("Base", db.update_config, {"base_currency": "RUB", "base_rate": "0.0125"})
        rates = {c["code"]: c["rate"] for c in self.state()["currencies"]}
        self.assertEqual((rates["RUB"], rates["USD"], rates["EUR"]), ("1", "80", "88"))

    def test_missing_rates_are_reported(self):
        self.wallet("Card", currency="EUR", balance="5")
        self.assertEqual(self.state()["totals"]["missing_rates"], ["EUR"])

    def test_cant_remove_used_currency(self):
        self.wallet("Card", currency="EUR")
        with self.assertRaises(ApiError):
            self.w("Remove", db.delete_currency, "EUR")
        self.w("Remove", db.delete_currency, "ETH")
        self.assertNotIn("ETH", [c["code"] for c in self.state()["currencies"]])
        self.db.undo()
        self.assertIn("ETH", [c["code"] for c in self.state()["currencies"]])


class Undo(Base):
    def test_undo_edit_restores_lines(self):
        card = self.wallet("Card", balance="100")
        tx_id = self.tx("expense", [{"wallet_id": card, "amount": "-10"}])
        self.w("Edit", db.update_transaction, tx_id, {"entries": [
            {"wallet_id": card, "amount": "-7"}, {"wallet_id": card, "amount": "-1"}]})
        self.assertEqual(self.balance(card), "92.00")
        self.assertEqual(self.db.undo()["undone"], "Edit")
        self.assertEqual(self.balance(card), "90.00")
        self.db.undo()
        self.assertEqual(self.balance(card), "100.00")

    def test_undo_survives_restart(self):
        card = self.wallet("Card", balance="100")
        self.tx("expense", [{"wallet_id": card, "amount": "-10"}])
        self.db.close()
        self.db = db.Database(self.path)
        self.db.undo()
        self.assertEqual(self.balance(card), "100.00")

    def test_failed_action_changes_nothing(self):
        card = self.wallet("Card", balance="100")
        with self.assertRaises(ApiError):
            self.tx("expense", [{"wallet_id": card, "amount": "-1"}, {"wallet_id": card, "amount": "5"}])
        self.assertEqual(self.balance(card), "100.00")
        self.assertEqual(self.db.undo()["undone"], "Add wallet")

    def test_depth(self):
        card = self.wallet("Card")
        for n in range(db.UNDO_DEPTH + 5):
            self.w(f"Rename {n}", db.update_wallet, card, {"name": f"Card {n}"})
        batches = self.db.conn.execute("SELECT COUNT(DISTINCT batch) FROM undo_log").fetchone()[0]
        self.assertEqual(batches, db.UNDO_DEPTH)

    def test_nothing_to_undo(self):
        with self.assertRaises(ApiError):
            self.db.undo()


class Integrity(Base):
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
