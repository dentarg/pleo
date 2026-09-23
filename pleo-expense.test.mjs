import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import test from "node:test";

import {
  buildExpenseData,
  catalogEntries,
  discoverReceiptGroups,
  formatExpense,
  normalizeMinorMoney,
  normalizeRecentExpense,
  normalizeNote,
  parseArgs,
  parseRecentLimit,
  parseReceipt,
  parseReceiptFilename,
  receiptMimeType,
  resolveCountryCode,
  selectUnique,
  summarizeRecentExpenses,
} from "./pleo-expense.mjs";

test("parses a receipt", () => {
  const receipt = parseReceipt(`
    Tack för ditt köp den 15 januari 2026 09:20
    Summa betalt: 42 EUR
    Varav moms 6,0%: 2,38 EUR
    Betalningsmottagare: Example Transit AB, momsregistreringsnummer
  `);

  assert.deepEqual(receipt, {
    amount: 42,
    currency: "EUR",
    date: "2026-01-15",
    merchant: "Example Transit AB",
  });
});

test("parses CLI options", () => {
  assert.deepEqual(
    parseArgs(["expense", "receipt.pdf", "--project", "alpha", "--submit"]),
    {
      command: "expense",
      project: "alpha",
      receipts: ["receipt.pdf"],
      submit: true,
    },
  );
});

test("parses recent expense options", () => {
  assert.deepEqual(
    parseArgs(["recent", "--limit", "5", "--json"]),
    {
      command: "recent",
      json: true,
      limit: "5",
      submit: false,
    },
  );
  assert.equal(parseRecentLimit("5"), 5);
  assert.throws(() => parseRecentLimit("0"), /positive integer/);
});

test("normalizes a recent expense", () => {
  assert.deepEqual(
    normalizeRecentExpense({
      bill: {currency: "EUR", value: -42.5},
      expenseId: "expense-1",
      id: "entry-1",
      merchantName: "Example Transit",
      missingReceipts: false,
      performed: "2026-01-15T12:00:00.000Z",
      reviewStatus: "REVIEWED_AS_OKAY",
      status: "COMPLETED",
    }),
    {
      amount: 42.5,
      currency: "EUR",
      date: "2026-01-15",
      expenseId: "expense-1",
      id: "entry-1",
      merchant: "Example Transit",
      receiptStatus: "UPLOADED",
      reviewStatus: "REVIEWED_AS_OKAY",
      status: "COMPLETED",
    },
  );
});

test("normalizes a reimbursement balance from minor currency units", () => {
  assert.deepEqual(
    normalizeMinorMoney({currency: "SEK", value: 229376}),
    {amount: 2293.76, currency: "SEK"},
  );
});

test("labels reimbursement payouts without requiring receipts", () => {
  assert.deepEqual(
    normalizeRecentExpense({
      bill: {currency: "SEK", value: -100},
      expenseViewType: "reimbursement",
      family: "REIMBURSEMENT",
      id: "entry-1",
      missingReceipts: true,
      performed: "2026-01-15T12:00:00.000Z",
      reviewStatus: "NOT_REQUIRED",
      status: "COMPLETED",
    }),
    {
      amount: 100,
      currency: "SEK",
      date: "2026-01-15",
      expenseId: "entry-1",
      id: "entry-1",
      merchant: "Reimbursement",
      receiptStatus: "NOT_APPLICABLE",
      reviewStatus: "NOT_REQUIRED",
      status: "COMPLETED",
    },
  );
});

test("summarizes recent expenses by review status and currency", () => {
  assert.deepEqual(
    summarizeRecentExpenses([
      {
        amount: 10.25,
        currency: "EUR",
        receiptStatus: "UPLOADED",
        reviewStatus: "OK",
      },
      {
        amount: 4.75,
        currency: "EUR",
        receiptStatus: "MISSING",
        reviewStatus: "OK",
      },
      {
        amount: 20,
        currency: "SEK",
        receiptStatus: "UPLOADED",
        reviewStatus: "WAITING_FOR_REVIEWER",
      },
    ]),
    [
      {
        amount: 15,
        currency: "EUR",
        expenseCount: 2,
        receiptCount: 1,
        status: "OK",
      },
      {
        amount: 20,
        currency: "SEK",
        expenseCount: 1,
        receiptCount: 1,
        status: "WAITING_FOR_REVIEWER",
      },
    ],
  );
});

test("accepts supporting PDF files", () => {
  assert.deepEqual(
    parseArgs(["expense", "receipt.pdf", "statement.pdf"]),
    {
      command: "expense",
      receipts: ["receipt.pdf", "statement.pdf"],
      submit: false,
    },
  );
});

test("groups a receipt directory with mixed receipt formats", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pleo-expense-test-"));
  context.after(() => rm(directory, {force: true, recursive: true}));
  const first = "2026-01-15_Example_Transit_42_EUR_transport_alpha_DE";
  const second = "2026-01-16_Example_Hotel_120_EUR_lodging_alpha_DE";
  const filenames = [
    `${first}_Client_dinner.png`,
    `${first}_2.png`,
    `${first}_3.pdf`,
    `${second}.pdf`,
  ];

  await Promise.all(
    filenames.map((filename) => writeFile(join(directory, filename), "fixture")),
  );

  const groups = await discoverReceiptGroups(directory);

  assert.deepEqual(
    groups.map((group) => group.map((path) => basename(path))),
    [
      [`${first}_Client_dinner.png`, `${first}_2.png`, `${first}_3.pdf`],
      [`${second}.pdf`],
    ],
  );
});

test("parses expense metadata from a filename", () => {
  assert.deepEqual(
    parseReceiptFilename(
      "2026-01-15_Example_Transit_42_EUR_local-transport_alpha_DE.pdf",
    ),
    {
      amount: 42,
      category: "local-transport",
      country: "DE",
      currency: "EUR",
      date: "2026-01-15",
      merchant: "Example Transit",
      project: "alpha",
    },
  );
});

test("parses an empty project from a filename", () => {
  assert.deepEqual(
    parseReceiptFilename(
      "2026-01-15_Example_Transit_42_EUR_local-transport__DE.pdf",
    ),
    {
      amount: 42,
      category: "local-transport",
      country: "DE",
      currency: "EUR",
      date: "2026-01-15",
      merchant: "Example Transit",
      project: null,
    },
  );
});

test("omits project tags when an expense has no project", () => {
  const data = buildExpenseData({
    options: {},
    receipt: {
      amount: 42,
      currency: "EUR",
      merchant: "Example Transit",
    },
    receiptBuffer: Buffer.from("receipt"),
    resolved: {
      accountingDate: "2026-01-15",
      category: {id: "category-1"},
      country: "DE",
      project: null,
      projectGroup: null,
    },
  });

  assert.deepEqual(data.tagGroups, []);
});

test("requires a country token in a receipt filename", () => {
  assert.equal(
    parseReceiptFilename(
      "2026-01-15_Example_Transit_42_EUR_local-transport_alpha_DE.pdf",
    ).country,
    "DE",
  );
  assert.equal(
    parseReceiptFilename(
      "2026-01-15_Example_Transit_42_EUR_local-transport_alpha.pdf",
    ),
    null,
  );
});

test("parses an optional filename comment as the expense note", () => {
  assert.equal(
    parseReceiptFilename(
      "2026-01-15_Example_Transit_42_EUR_local-transport_alpha_DE_Client_dinner.pdf",
    ).note,
    "Client dinner",
  );
});

test("shows the expense note in a dry-run overview", () => {
  const output = formatExpense({
    accountingDate: "2026-01-15",
    amount: 42,
    category: "Local transport",
    country: "DE",
    currency: "EUR",
    merchant: "Example Transit",
    note: "Client dinner",
    primaryReceipt: "receipt.pdf",
    project: null,
    receiptDate: "2026-01-15",
    receiptFiles: 1,
  }, {dryRun: true});

  assert.match(output, /^Note\s+Client dinner$/m);
});

test("requires an exact ISO country token", () => {
  assert.equal(resolveCountryCode("GB"), "GB");
  assert.throws(
    () => resolveCountryCode("UK"),
    /No country token matched "UK"; use \.\/pleo countries/,
  );
});

test("normalizes a missing expense note to an empty string", () => {
  assert.equal(normalizeNote(undefined), "");
  assert.equal(normalizeNote("Client dinner"), "Client dinner");
});

test("parses expense metadata from a PNG filename", () => {
  assert.deepEqual(
    parseReceiptFilename(
      "2026-01-15_Example_Transit_42.50_EUR_local-transport_alpha_DE.png",
    ),
    {
      amount: 42.5,
      category: "local-transport",
      country: "DE",
      currency: "EUR",
      date: "2026-01-15",
      merchant: "Example Transit",
      project: "alpha",
    },
  );
});

test("selects the receipt MIME type from its extension", () => {
  assert.equal(receiptMimeType("receipt.PDF"), "application/pdf");
  assert.equal(receiptMimeType("receipt.PNG"), "image/png");
  assert.equal(receiptMimeType("receipt.jpg"), null);
});

test("generates a unique project token", () => {
  const projects = [
    {label: "2026 Sep - Alpha Conference (27)"},
    {label: "2026 Nov - Winter Meetup (28)"},
  ];
  const entries = catalogEntries(projects, (project) => project.label);

  assert.equal(entries[0].token, "alpha");
  assert.equal(entries[1].token, "winter");
});

test("requires a unique project match", () => {
  const items = [{label: "Alpha 2025"}, {label: "Alpha 2026"}];

  assert.throws(
    () => selectUnique(items, "Alpha", (item) => item.label, "project"),
    /Multiple project values matched/,
  );
});
