# Pleo expense CLI

This CLI lists Pleo categories, countries, and projects; creates an
out-of-pocket expense; and uploads its PDF or PNG receipts without navigating
the Pleo UI. It uses the authenticated host browser only to obtain a
short-lived Pleo session; credentials are neither requested nor stored. Its
temporary authentication tab opens in the background, so the CLI does not
steal browser focus.

Install dependencies:

```sh
npm install
```

List the valid filename tokens:

```sh
./pleo categories
./pleo countries
./pleo projects
```

List the 10 most recent expenses and their review status:

```sh
./pleo recent
./pleo recent --limit 25
./pleo recent --json
```

The listing includes the expense date, merchant, amount, transaction status,
review status, and whether a receipt is uploaded or missing. Totals are grouped
by review status and currency. The receipt total counts expenses with an
uploaded receipt, not individual attachment files. JSON output includes both
the expenses and grouped totals. Reimbursement payouts are labelled as such
and show `Not applicable` instead of a receipt status. The current approved
balance that Pleo still owes you is shown separately as awaiting payout.

Name receipts using the category and project tokens:

```text
YYYY-MM-DD_MERCHANT_AMOUNT_CURRENCY_CATEGORY_PROJECT_COUNTRY[_COMMENT].{pdf,png}
```

For example:

```text
2026-01-15_Example_Transit_42_EUR_category-token_project-token_DE.pdf
```

Preview an expense without creating it:

```sh
./pleo expense \
  2026-01-15_Example_Transit_42_EUR_category-token_project-token_DE.pdf
```

Create it after reviewing the preview:

```sh
./pleo expense \
  2026-01-15_Example_Transit_42_EUR_category-token_project-token_DE.pdf \
  bank-statement.pdf \
  --submit
```

The first file is the primary receipt and supplies filename metadata. Country
is required. The optional comment becomes the expense note; underscores in it
are converted to spaces. `--note` overrides the filename comment.

For an expense without a project, leave the project segment empty. The two
adjacent underscores between the category and country are required:

```text
2026-01-15_Example_Transit_42_EUR_category-token__DE.pdf
```

Any additional PDF or PNG files are uploaded as supporting documents on the
same expense. PNG files must provide all receipt metadata through their
filename or CLI overrides; unlike PDFs, their contents are not scanned for
text.

To process a directory, name supporting files after their primary receipt with
consecutive suffixes starting at `_2`. PDF and PNG formats may be mixed:

```text
2026-01-15_Example_Transit_42_EUR_category-token_project-token_DE_Client_dinner.pdf
2026-01-15_Example_Transit_42_EUR_category-token_project-token_DE_2.png
2026-01-15_Example_Transit_42_EUR_category-token_project-token_DE_3.pdf
```

Supporting filenames do not need to repeat the primary receipt's comment.

Preview or submit every receipt group in the directory:

```sh
./pleo expense receipts/
./pleo expense receipts/ --submit
```

To have Claude Code or Codex analyze, reconcile, and rename an unprepared
receipt directory first, invoke the repository skill with the directory path:

```text
# Claude Code
/prepare-pleo-receipts receipts/

# Codex
$prepare-pleo-receipts receipts/
```

The skill always uses the actual charged SEK amount in filenames, groups card
slips and statements with their primary receipts, and validates the directory
without submitting expenses.

The directory scan rejects unrecognized receipt names, orphaned supporting
files, and gaps in the supporting-file sequence before creating any expenses.

Use `--merchant`, `--date`, `--amount`, `--currency`, `--category`, or
`--project` when a receipt needs an override. `--country` accepts a token from
`./pleo countries`. `--json` gives machine-readable output for listings and
expense results.

Submission uses a deterministic idempotency key derived from the primary
receipt bytes to make retries safe. Expense creation and each receipt upload
are checked separately; an upload error reports the created expense ID and how
many receipt files succeeded so the expense is not submitted twice.
