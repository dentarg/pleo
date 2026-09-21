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
