# Browser file uploads

The authenticated host browser cannot read container filesystem paths such as
`/app/receipt.pdf`. Puppeteer's `ElementHandle.uploadFile()` may populate the
input with the filename while leaving the browser unable to read the file, so
the application can fail when it later uploads the contents.

For host-browser uploads, read the file in the container, transfer its bytes
through CDP, reconstruct a browser-native `File`, assign it with
`DataTransfer`, and dispatch `change`:

```js
const base64 = fs.readFileSync(path).toString("base64");

await page.evaluate(({base64, filename, type, selector}) => {
  const raw = atob(base64);
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  const file = new File([bytes], filename, {type});
  const transfer = new DataTransfer();

  transfer.items.add(file);

  const input = document.querySelector(selector);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", {bubbles: true}));
}, {base64, filename, type: "application/pdf", selector});
```

Verify success from the application's upload response and resulting UI state,
not merely from the filename appearing in the file input.

## Pleo expense entry

- Use `./pleo categories`, `./pleo countries`, and `./pleo projects` to obtain
  filename tokens.
- Name receipts as
  `YYYY-MM-DD_MERCHANT_AMOUNT_CURRENCY_CATEGORY_PROJECT[_COUNTRY].pdf`.
- Use `./pleo expense RECEIPT.pdf [SUPPORTING.pdf ...]` for a dry run, then
  repeat with `--submit` after reviewing its resolved values.
- For directory processing, name supporting PDFs after the primary receipt
  with consecutive `_2`, `_3`, and later suffixes. The CLI validates every
  group before submitting it.
- Open temporary host-browser tabs with `browser.newPage({background: true})`
  so automation does not steal window focus.
- User-provided files are normally under `/app`; confirm with `pwd` and `ls`
  before searching elsewhere.
- Extract and verify the receipt's merchant, date, amount, currency, and VAT
  before entering the expense.
- Pleo's amount control initially renders as `type="text"`, then changes to
  `type="number"` shortly after focus. Wait for that change before typing so
  Formik stores a number. A visually correct string is otherwise submitted as
  `0` and rejected with HTTP 422.
- Before submission, inspect the request payload and confirm that
  `amount.value` is numeric and non-zero.
- Treat expense creation and receipt upload as separate operations. If Pleo
  reports that the expense was created but the receipt failed, do not submit
  the expense again. Open the created expense and retry only the receipt using
  the browser-native `File` method above.
- Confirm completion from the API responses and the detail view: the expense
  creation should succeed, the receipt request should return success, and the
  receipt should appear as uploaded.
- Avoid typing ISO dates into the browser's native date widget: segment-based
  input can silently produce another date. Compare the ISO receipt date with
  Pleo's `getExpenseAllowedFrom` value and submit the later date directly.
