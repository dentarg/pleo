---
name: prepare-pleo-receipts
description: Analyze, reconcile, group, and rename PDF or PNG receipts in a directory for this repository's Pleo expense CLI. Use when a user supplies a receipt directory that must be prepared or checked before `./pleo expense DIRECTORY`; do not use this skill to submit expenses unless submission is separately requested.
---

# Prepare Pleo Receipts

Prepare the directory supplied by the user so `./pleo expense DIRECTORY` can
process every expense group. Treat the first directory in the request as the
target. Ask for a path only when none can be inferred.

Read the repository's `AGENTS.md` and preserve all receipt contents. This task
authorizes renaming files, not changing their bytes or submitting expenses.

## Inspect

1. Confirm the target directory and inventory every file before renaming.
2. Obtain valid tokens with `./pleo categories`, `./pleo countries`, and
   `./pleo projects`. If live lookup is unavailable, use a recent saved export
   only when its origin is clear, and report that live token validation remains
   pending.
3. Check for `pdftotext`, `pdftoppm`, and `tesseract`. Report missing tools;
   install them only when the user and environment authorize installation.
   Debian/Ubuntu packages are `poppler-utils` and `tesseract-ocr`.
4. Extract embedded PDF text with `pdftotext -layout`. For scanned PDFs, render
   bounded images with `pdftoppm -scale-to 2400`, then OCR them. OCR PNG files
   directly. Visually inspect the source whenever OCR leaves the date, merchant,
   amount, VAT, or currency ambiguous.

For each expense, identify and cross-check:

- merchant and merchant country;
- receipt or service date;
- original amount and currency;
- VAT amount or rate;
- actual amount charged in SEK;
- suitable category and project tokens;
- all receipt, card-slip, and statement files belonging to the same charge.

Use the merchant receipt date rather than a later bank posting date. Prefer a
settled bank-card charge for the SEK amount, followed by an exact SEK amount on
the merchant receipt. Include card fees, tips, discounts, or credits so the
filename equals the amount actually charged. Never put the foreign-currency
total in the filename and label it SEK. If no exact SEK charge is available,
stop and ask the user instead of estimating an exchange rate.

## Rename and group

Use this primary filename format:

```text
YYYY-MM-DD_MERCHANT_AMOUNT_SEK_CATEGORY_PROJECT_COUNTRY[_COMMENT].{pdf,png}
```

Use readable ASCII merchant names with words separated by underscores. Keep the
expense country as the two-letter country token, even though the amount is SEK.
Use the primary receipt as the unsuffixed file. Rename supporting files to the
same metadata stem, excluding any optional comment, with consecutive `_2`,
`_3`, and later suffixes. Prefer the itemized or tax receipt as primary and use
card slips and bank screenshots as supporting files.

Build and review a complete old-to-new mapping before applying any rename.
Reject duplicate destinations and do not overwrite files. Normalize `.PDF` and
`.PNG` extensions to lowercase while renaming.

## Validate

Run the bundled validator from the repository root:

```sh
node .agents/skills/prepare-pleo-receipts/scripts/validate-directory.mjs DIRECTORY
```

It must report that every expense group uses SEK and that supporting numbering
is valid. Also confirm every category, project, and country token against the
live or saved catalogs used during analysis.

When authenticated browser access is available, run `./pleo expense DIRECTORY`
without `--submit` and review every resolved value. Never add `--submit` unless
the user explicitly requests submission after reviewing the dry run.

Report the number of expense groups and files, any installed packages, and any
uncertainties. Call out reconciliations where the charged SEK amount differs
from the receipt total because of tips, fees, discounts, or credits.
