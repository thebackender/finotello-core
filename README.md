# Finotello

A local personal finance tracker: wallets (bank, cash, crypto) in any currency, spending by category, income sources,
the total across all wallets, monthly payments, planned expenses with savings, debts, and a safety cushion.
Needs only Python 3: no packages to install, no build step. Data lives in one SQLite file.
The one third-party library, [Coloris](https://github.com/mdbassit/Coloris) (color picker, MIT), is included in `web/vendor/`, so everything works offline.

## Run

```bash
python3 server.py              # http://localhost:8010
python3 server.py 9000         # on another port
python3 server.py --data-dir ~/finance-test   # another set of books, e.g. to try things out
```

Settings can also live in a `.env` file next to `server.py` (see `.env.example`): `FIN_PORT`, `FIN_DATA_DIR`, `FIN_BACKUP_DIR`.
Command-line options win over `.env`.

The server listens on `127.0.0.1` only, so it isn't reachable from the network. The API also refuses requests from other
sites open in your browser: it only accepts JSON, from this page's own address (`localhost` or `127.0.0.1`).

Tests: `python3 -m unittest discover tests`

## Tabs

| Key | Tab | What it does |
|---|---|---|
| 1 | Overview | Money in all your wallets in the base currency, split into bank / cash / crypto; what people owe you and what you owe. The eye button next to it hides these balances (here and in Wallets) behind asterisks, e.g. when someone looks at your screen; it stays hidden until you click it again. Under it, spending and income for a period you pick on a calendar (click the start and end days, or type the dates; it is kept in the database; "This month" goes back to the current month, which is also the default): spending by category as a pie (the six largest; smaller ones fold into "Other"; the list next to it gives each amount and share) and income by source as bars, each with its total. Click a category or "Other" to see what's inside. Changing the period redraws only this part. At the bottom, monthly payments, plans, budgets and the cushion at a glance |
| 2 | Transactions | Everything by day, a month at a time or all time. Filter by wallet, category (with its subcategories) or type; search notes and line descriptions. Click a transaction to edit or delete it. In its dialog, **Repeat** opens a copy dated today, and **Save as template** keeps the form (wallet, lines, amounts, note): pick one in the small "Templates" field next to the title of New transaction (type to search; Enter fills the form, and Enter again saves when nothing is missing) |
| 3 | Plans | **Monthly payments**: rent, subscriptions, loans; their sum per month, and which are paid this month (Pay records the expense with the real amount; "paid" counts what you really paid). A payment marked **the amount varies** (utilities, phone) is expected to cost the average of its last 3 payments; until it has any, the rough amount you entered. **Budgets**: a monthly limit for a spending category (its subcategories count toward it), what is spent this month and what is left; the bar turns amber from 90% and red past the limit. **Planned expenses**: a laptop, dental treatment; the total, what is saved for each (Save puts money aside: it stays in your wallets, only marked for the plan), Bought records the purchase. **Safety cushion**: the target, how much is saved, how much is left, how many months of payments it covers |
| 4 | Wallets | **Capital by month**: money in your wallets at the end of each month, and with debts, as a line chart (at today's rates; hover or use the arrow keys for a month's numbers, "Table" lists them all). Wallets by type with their balance (and its value in the base currency). **Debts**: one entry per person, Give / Get money |
| 5 | Settings | Base currency and exchange rates, spending categories and income sources, transaction templates (rename, delete), theme, export to CSV / JSON |

## Keyboard shortcuts

- `1`–`5`: switch tabs
- `N`: new transaction (in Transactions with a wallet filter, from that wallet)
- `Esc`: close a dialog or a list

Shortcuts work with any keyboard layout (`N` is also `Т` on a Russian layout).

## How money is recorded

A **transaction** has a date, a type and a note, and one or more **lines**. Each line changes one wallet's balance,
in that wallet's currency, and may have a category and a description. A wallet's balance is the sum of its lines.

| Type | Lines |
|---|---|
| Expense | one or more lines below zero, each with its own category and description (a split receipt: `Food:Fruits −1200 apples`, `Household −2000 detergent`) |
| Income | lines above zero, with income categories (sources) |
| Transfer | money leaves one wallet and arrives in another; in different currencies you enter both amounts (that's the exchange rate you got). A fee is an extra line with an expense category |
| Debt | money to or from a person (see below) |
| Balance adjustment | a wallet's starting balance, entered when you add it |

**Debts.** Every person is a wallet of type "debt". Its balance above zero means they owe you, below zero means you owe them.
Lending 10 000 is a debt transaction `card −10 000, Ivan +10 000`; when Ivan pays back 4 000, `Ivan −4 000, card +4 000`.

**Categories** go two levels deep: `Category` or `Category:Subcategory`. Type `Food:Snacks` in a category field and
"+ Create" makes whatever is missing. Reports count a category together with its subcategories.
Deleting a category keeps it on old transactions (shown struck through); **Merge into…** moves its transactions to another one.

**Currencies.** Each wallet has one currency. If you picked the wrong one, change it in the wallet's editor: every amount keeps its number in the new currency (1 000 ₽ becomes $1 000). That works while the wallet's transactions involve it alone (starting balance, expenses, income); once it has transfers or debts with other wallets, the currency is fixed, and you move the money to a new wallet with a transfer. Totals are in the base currency, at the rates you
enter in Settings (one unit of a currency = so much of the base currency). There is one current rate per currency:
when you change it, all totals and reports are recounted. A currency in use with no rate counts as zero, and a warning says so.
Changing the base currency recounts all rates through the new one, and the cushion target and budgets keep their value in it.

**What counts as spending:** lines with an expense category, in any type of transaction (so transfer fees count),
and expense lines without a category. Transfers, debts and balance adjustments don't.

## Data

Everything is in `data/finance.db` (SQLite; open it with `sqlite3` or DB Browser for SQLite). Amounts are stored as integers
in the currency's smallest unit (cents, kopecks, satoshi), so sums are exact. Deleting a wallet, category, payment or plan
only marks it `is_deleted`: the row stays in the file, but the app doesn't bring it back, and there is no undo.
A wallet with transactions can't be deleted: archive it instead.

Before the first change of each day the server copies the database to `finance-YYYY-MM-DD.db` in the backup folder
(`data/backups/`, or `--backup-dir` / `FIN_BACKUP_DIR`). The archive button in the header makes a copy right away
(`finance-YYYY-MM-DD_HH-MM-SS.db`). The last 14 of each kind are kept. To roll back, stop the server and copy a backup
over `data/finance.db`.

`data/settings.json` keeps the theme, the tabs' view options and whether balances are hidden. Delete it to reset them.

### Tables

| Table | Fields |
|---|---|
| `config` | `base_currency`, `cushion_target` (minor units of the base currency), `report_from`, `report_to` (Overview's income and spending period; empty = the current month) |
| `currencies` | `code`, `name`, `kind` (fiat / crypto), `decimals`, `rate` (base currency per unit, a decimal as text; `0` = not set), `rate_updated` |
| `wallets` | `name`, `type` (bank / cash / crypto / debt), `currency`, `color`, `note`, `is_cushion`, `is_archived`, `is_deleted` |
| `categories` | `name`, `kind` (expense / income), `parent_id`, `color`, `is_active`, `is_deleted`, `budget` (a monthly limit in minor units of the base currency; empty = none) |
| `transactions` | `date`, `type`, `note`, `recurring_id` (a monthly payment it pays), `planned_id` (a plan it buys), `is_deleted` |
| `entries` | `transaction_id`, `wallet_id`, `amount` (minor units, with a sign), `category_id`, `description` |
| `recurring` | monthly payments: `name`, `amount` (for a varying one, roughly), `currency`, `category_id`, `wallet_id`, `day`, `is_active`, `is_variable` |
| `planned` | `name`, `amount`, `currency`, `category_id`, `priority`, `due`, `notes`, `status` (open / done / dropped) |
| `plan_savings` | money put aside for a plan (or taken back, below zero): `planned_id`, `date`, `amount`, `note` |
| `templates` | saved transaction forms: `name`, `type`, `data` (the form as JSON: wallets, lines, amounts, note; an amount may be empty) |

The schema version is `PRAGMA user_version`; new versions add a migration at the end of `MIGRATIONS` in `db.py`. When the server opens an older database, it first copies it to `finance-before-vN-….db` in the backup folder (kept until you delete it), then upgrades it.

### Limits

Checked by the server (`LIMITS` in `db.py`); the UI stops typing at the same length.

| What | Limit |
|---|---|
| Wallet, payment, plan name | 60 characters |
| Category name | 40 characters |
| Note | 500 characters |
| Line description | 200 characters |
| Plan notes | 2 000 characters |
| Lines in one transaction | 50 |
| One amount | 10 000 000 000 units |
| Decimals of a currency | 0–8 |

## Layout

```
server.py              HTTP server, routes, backups, .env
db.py                  SQLite schema and migrations, money math, every change and query
tests/                 unittest: db.py and the HTTP API
web/index.html         page
web/style.css          styles
web/js/app.js          tabs and keyboard shortcuts
web/js/store.js        state and API calls
web/js/money.js        formatting and exact sums
web/js/editor.js       dialogs: transaction, wallet, payment, plan
web/js/chart.js        pie, meter, segmented bar
web/js/rangepicker.js  period picker: two months of calendar
web/js/privacy.js      hide balances (the eye button)
web/js/views/*.js      one file per tab; reports.js is the income and spending part of Overview
```
