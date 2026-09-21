import assert from "node:assert/strict";
import test from "node:test";

import {
  catalogEntries,
  parseArgs,
  parseReceipt,
  parseReceiptFilename,
  selectUnique,
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

test("parses expense metadata from a filename", () => {
  assert.deepEqual(
    parseReceiptFilename(
      "2026-01-15_Example_Transit_42_EUR_local-transport_alpha.pdf",
    ),
    {
      amount: 42,
      category: "local-transport",
      currency: "EUR",
      date: "2026-01-15",
      merchant: "Example Transit",
      project: "alpha",
    },
  );
});

test("parses an optional country token from a filename", () => {
  assert.equal(
    parseReceiptFilename(
      "2026-01-15_Example_Transit_42_EUR_local-transport_alpha_DE.pdf",
    ).country,
    "DE",
  );
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
