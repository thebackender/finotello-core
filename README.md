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
| 1 | Overview | Money in all your wallets in the base currency, split into bank / cash / crypto; what people owe you and what you owe; income, spending and what's left this month; free money (after the cushion and plan savings); monthly payments, plans and the cushion at a glance; this month's spending by category |
| 2 | Transactions | Everything by day, a month at a time or all time. Filter by wallet, category (with its subcategories) or type; search notes and line descriptions. Click a transaction to edit or delete it |
| 3 | Reports | Spending by category and income by source for a period (this month, last month, 3 months, this year, 12 months, custom). Click a category to see its subcategories. Income vs spending by month for the 12 months up to the period's end, with a table view |
| 4 | Plans | **Monthly payments**: rent, subscriptions, loans; their sum per month, and which are paid this month (Pay records the expense). **Planned expenses**: a laptop, dental treatment; the total, what is saved for each (Save puts money aside, it stays in your wallets but no longer counts as free), Bought records the purchase. **Safety cushion**: the target, how much is saved, how much is left, how many months of payments it covers |
| 5 | Wallets | Wallets by type with their balance (and its value in the base currency). **Check** compares with the real balance and records the difference. **Debts**: one entry per person, Give / Get money |
| 6 | Settings | Base currency and exchange rates, spending categories and income sources, theme, export to CSV / JSON |

## Keyboard shortcuts

- `1`–`6`: switch tabs
- `N`: new transaction (in Transactions with a wallet filter, from that wallet)
- `Ctrl+Z`: undo the last change (up to 30 steps, kept in the database, so they survive a restart)
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
| Balance adjustment | made by Check and by a wallet's starting balance |

**Debts.** Every person is a wallet of type "debt". Its balance above zero means they owe you, below zero means you owe them.
Lending 10 000 is a debt transaction `card −10 000, Ivan +10 000`; when Ivan pays back 4 000, `Ivan −4 000, card +4 000`.
If a friend pays for your lunch, record an expense from the friend: it counts as spending, and your debt to them grows.

**Categories** go two levels deep: `Category` or `Category:Subcategory`. Type `Food:Snacks` in a category field and
"+ Create" makes whatever is missing. Reports count a category together with its subcategories.
Deleting a category keeps it on old transactions (shown struck through); **Merge into…** moves its transactions to another one.

**Currencies.** Each wallet has one currency, set when you create it. Totals are in the base currency, at the rates you
enter in Settings (one unit of a currency = so much of the base currency). There is one current rate per currency:
when you change it, all totals and reports are recounted. A currency in use with no rate counts as zero, and a warning says so.
Changing the base currency recounts all rates through the new one.

**What counts as spending:** lines with an expense category, in any type of transaction (so transfer fees count),
and expense lines without a category. Transfers, debts and balance adjustments don't.

## Data

Everything is in `data/finance.db` (SQLite; open it with `sqlite3` or DB Browser for SQLite). Amounts are stored as integers
in the currency's smallest unit (cents, kopecks, satoshi), so sums are exact. Deleting a wallet, category, payment or plan
only marks it `is_deleted`; Ctrl+Z brings it back. A wallet with transactions can't be deleted: archive it instead.

Before the first change of each day the server copies the database to `finance-YYYY-MM-DD.db` in the backup folder
(`data/backups/`, or `--backup-dir` / `FIN_BACKUP_DIR`). The archive button in the header makes a copy right away
(`finance-YYYY-MM-DD_HH-MM-SS.db`). The last 14 of each kind are kept. To roll back, stop the server and copy a backup
over `data/finance.db`.

`data/settings.json` keeps the theme and the tabs' view options. Delete it to reset them.

### Tables

| Table | Fields |
|---|---|
| `config` | `base_currency`, `cushion_target` (minor units of the base currency) |
| `currencies` | `code`, `name`, `kind` (fiat / crypto), `decimals`, `rate` (base currency per unit, a decimal as text; `0` = not set), `rate_updated` |
| `wallets` | `name`, `type` (bank / cash / crypto / debt), `currency`, `color`, `note`, `is_cushion`, `is_archived`, `is_deleted` |
| `categories` | `name`, `kind` (expense / income), `parent_id`, `color`, `is_active`, `is_deleted` |
| `transactions` | `date`, `type`, `note`, `recurring_id` (a monthly payment it pays), `planned_id` (a plan it buys), `is_deleted` |
| `entries` | `transaction_id`, `wallet_id`, `amount` (minor units, with a sign), `category_id`, `description` |
| `recurring` | monthly payments: `name`, `amount`, `currency`, `category_id`, `wallet_id`, `day`, `is_active` |
| `planned` | `name`, `amount`, `currency`, `category_id`, `priority`, `due`, `notes`, `status` (open / done / dropped) |
| `plan_savings` | money put aside for a plan (or taken back, below zero): `planned_id`, `date`, `amount`, `note` |
| `undo_log` | the rows each action changed, as they were before, for Ctrl+Z |

The schema version is `PRAGMA user_version`; new versions add a migration at the end of `MIGRATIONS` in `db.py`.

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
db.py                  SQLite schema and migrations, money math, every change and query, undo
tests/                 unittest: db.py and the HTTP API
web/index.html         page
web/style.css          styles
web/js/app.js          tabs and keyboard shortcuts
web/js/store.js        state and API calls
web/js/money.js        formatting and exact sums
web/js/editor.js       dialogs: transaction, wallet, balance check, payment, plan
web/js/chart.js        column chart, meter, segmented bar
web/js/views/*.js      one file per tab
```
