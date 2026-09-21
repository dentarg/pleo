# Pleo expense CLI

This CLI lists Pleo categories, countries, and projects; creates an
out-of-pocket expense; and uploads its PDF receipts without navigating the
Pleo UI. It uses the authenticated host browser only to obtain a short-lived
Pleo session; credentials are neither requested nor stored. Its temporary
authentication tab opens in the background, so the CLI does not steal browser
focus.

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

Name receipts using the category and project tokens:

```text
YYYY-MM-DD_MERCHANT_AMOUNT_CURRENCY_CATEGORY_PROJECT[_COUNTRY].pdf
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

The first PDF is the primary receipt and supplies filename metadata. Any
additional PDFs are uploaded as supporting documents on the same expense.
Country is optional and defaults to the company's country.

To process a directory, name supporting PDFs after their primary receipt with
consecutive suffixes starting at `_2`:

```text
2026-01-15_Example_Transit_42_EUR_category-token_project-token_DE.pdf
2026-01-15_Example_Transit_42_EUR_category-token_project-token_DE_2.pdf
2026-01-15_Example_Transit_42_EUR_category-token_project-token_DE_3.pdf
```

Preview or submit every receipt group in the directory:

```sh
./pleo expense receipts/
./pleo expense receipts/ --submit
```

The directory scan rejects unrecognized PDF names, orphaned supporting files,
and gaps in the supporting-file sequence before creating any expenses.

Use `--merchant`, `--date`, `--amount`, `--currency`, `--category`, or
`--project` when a receipt needs an override. `--country` accepts a token from
`./pleo countries`. `--json` gives machine-readable output for listings and
expense results.

Submission uses a deterministic idempotency key derived from the primary
receipt bytes to make retries safe. Expense creation and each receipt upload
are checked separately; an upload error reports the created expense ID and how
many PDFs succeeded so the expense is not submitted twice.
