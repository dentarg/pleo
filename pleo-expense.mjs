#!/usr/bin/env node

import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {readdir, readFile, stat} from "node:fs/promises";
import {basename, join} from "node:path";
import process from "node:process";
import {pathToFileURL} from "node:url";

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const isoCountries = require("i18n-iso-countries");
isoCountries.registerLocale(require("i18n-iso-countries/langs/en.json"));

const PLEO_APP_URL = "https://app.pleo.io/expenses";
const TOKEN_STOP_WORDS = new Set([
  "2024",
  "2025",
  "2026",
  "and",
  "apr",
  "aug",
  "dec",
  "feb",
  "for",
  "in",
  "jan",
  "jul",
  "jun",
  "mar",
  "may",
  "nov",
  "oct",
  "of",
  "sep",
  "the",
]);

function usage() {
  return `Usage:
  ./pleo categories [--json]
  ./pleo countries [--json]
  ./pleo projects [--json]
  ./pleo expense RECEIPT.pdf [SUPPORTING.pdf ...] [options]
  ./pleo expense DIRECTORY [options]

Expense options:
  --amount NUMBER       Override the extracted amount
  --category TOKEN      Override the filename category
  --country CODE        Merchant country (default: company country)
  --currency CODE       Override the extracted currency
  --date YYYY-MM-DD     Override the extracted receipt date
  --merchant NAME       Override the extracted merchant
  --note TEXT           Add an expense note
  --project TOKEN       Override the filename project
  --json                Print machine-readable output
  --submit              Create the expense; otherwise perform a dry run
  --help                Show this help

Receipt filename:
  YYYY-MM-DD_MERCHANT_AMOUNT_CURRENCY_CATEGORY_PROJECT[_COUNTRY].pdf

Supporting filename:
  YYYY-MM-DD_MERCHANT_AMOUNT_CURRENCY_CATEGORY_PROJECT[_COUNTRY]_N.pdf

Example:
  2026-01-15_Example_Transit_42_EUR_category-token_project-token_DE.pdf
`;
}

export function parseArgs(argv) {
  const options = {
    submit: false,
  };
  const args = [...argv];

  if (["categories", "countries", "projects"].includes(args[0])) {
    options.command = args.shift();
  } else if (args[0] === "expense") {
    options.command = args.shift();
  } else if (args[0] === "--help" || args.length === 0) {
    options.help = true;
    options.command = "help";
  } else {
    throw new Error(`Unknown command: ${args[0]}`);
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--submit") {
      options.submit = true;
      continue;
    }

    if (argument === "--json") {
      options.json = true;
      continue;
    }

    if (argument === "--help") {
      options.help = true;
      continue;
    }

    if (!argument.startsWith("--")) {
      if (options.command === "expense") {
        options.receipts ??= [];
        options.receipts.push(argument);
        continue;
      }

      throw new Error(`Unexpected argument: ${argument}`);
    }

    const name = argument.slice(2);
    const value = args[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }

    options[name] = value;
    index += 1;
  }

  return options;
}

export function parseReceiptFilename(filename) {
  const basename = filename.split(/[\\/]/).pop();
  const match = basename?.match(
    /^(20\d{2}-\d{2}-\d{2})_(.+)_([\d]+(?:[.,]\d+)?)_([A-Z]{3})_([^_]+)_([^_]+?)(?:_([A-Z]{2}))?\.pdf$/i,
  );

  if (!match) {
    return null;
  }

  return {
    amount: Number(match[3].replace(",", ".")),
    category: match[5],
    currency: match[4].toUpperCase(),
    date: match[1],
    merchant: match[2].replaceAll("_", " "),
    project: match[6],
    ...(match[7] ? {country: match[7].toUpperCase()} : {}),
  };
}

export async function discoverReceiptGroups(directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  const filenames = entries
    .filter((entry) => (
      (entry.isFile() || entry.isSymbolicLink())
      && entry.name.toLocaleLowerCase("en").endsWith(".pdf")
    ))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en", {numeric: true}));
  const primaryNames = [];
  const supportingByPrimary = new Map();
  const invalid = [];

  for (const filename of filenames) {
    const supportingMatch = filename.match(/^(.*)_(\d+)\.pdf$/i);
    const primaryFilename = supportingMatch
      ? `${supportingMatch[1]}.pdf`
      : null;

    if (
      supportingMatch
      && Number(supportingMatch[2]) >= 2
      && parseReceiptFilename(primaryFilename)
    ) {
      const supporting = supportingByPrimary.get(primaryFilename) ?? [];
      supporting.push({filename, number: Number(supportingMatch[2])});
      supportingByPrimary.set(primaryFilename, supporting);
    } else if (parseReceiptFilename(filename)) {
      primaryNames.push(filename);
    } else {
      invalid.push(filename);
    }
  }

  if (invalid.length > 0) {
    throw new Error(`Unrecognized receipt filenames: ${invalid.join(", ")}`);
  }

  for (const primaryFilename of supportingByPrimary.keys()) {
    if (!primaryNames.includes(primaryFilename)) {
      throw new Error(`Supporting PDFs have no primary receipt: ${primaryFilename}`);
    }
  }

  const groups = primaryNames.map((primaryFilename) => {
    const supporting = (supportingByPrimary.get(primaryFilename) ?? [])
      .sort((left, right) => left.number - right.number);
    const expectedNumbers = supporting.map((_, index) => index + 2);
    const actualNumbers = supporting.map(({number}) => number);

    if (actualNumbers.some((number, index) => number !== expectedNumbers[index])) {
      throw new Error(
        `Supporting PDFs for ${primaryFilename} must be numbered consecutively from 2`,
      );
    }

    return [
      join(directory, primaryFilename),
      ...supporting.map(({filename}) => join(directory, filename)),
    ];
  });

  if (groups.length === 0) {
    throw new Error(`No primary receipt PDFs found in ${directory}`);
  }

  return groups;
}

async function expandReceiptGroups(paths) {
  if (!paths?.length) {
    throw new Error("At least one receipt path is required");
  }

  const pathStats = await Promise.all(paths.map((path) => stat(path)));
  const directories = pathStats.filter((entry) => entry.isDirectory());

  if (directories.length === 0) {
    return [paths];
  }

  if (paths.length !== 1 || directories.length !== 1) {
    throw new Error("A receipt directory must be the only input path");
  }

  return discoverReceiptGroups(paths[0]);
}

export async function extractPdfText(buffer) {
  const document = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useWorkerFetch: false,
  }).promise;
  const pages = [];

  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(" "));
  }

  return pages.join("\n");
}

const MONTHS = new Map([
  ["january", 1],
  ["januari", 1],
  ["february", 2],
  ["februari", 2],
  ["march", 3],
  ["mars", 3],
  ["april", 4],
  ["may", 5],
  ["maj", 5],
  ["june", 6],
  ["juni", 6],
  ["july", 7],
  ["juli", 7],
  ["august", 8],
  ["september", 9],
  ["october", 10],
  ["oktober", 10],
  ["november", 11],
  ["december", 12],
]);

function parseDate(text) {
  const isoMatch = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);

  if (isoMatch) {
    return isoMatch[0];
  }

  const namedMatch = text.match(
    /\b(\d{1,2})\s+([A-Za-zÅÄÖåäö]+)\s+(20\d{2})\b/i,
  );

  if (!namedMatch) {
    return null;
  }

  const month = MONTHS.get(namedMatch[2].toLowerCase());

  if (!month) {
    return null;
  }

  return [
    namedMatch[3],
    String(month).padStart(2, "0"),
    namedMatch[1].padStart(2, "0"),
  ].join("-");
}

function parseMoney(text) {
  const match = text.match(
    /(?:Summa\s+betalt|Total(?:\s+paid)?)\s*:?\s*([\d\s.,]+)\s*([A-Z]{3})/i,
  );

  if (!match) {
    return {};
  }

  const normalized = match[1]
    .replace(/\s/g, "")
    .replace(/,(?=\d{1,2}$)/, ".");

  return {
    amount: Number(normalized),
    currency: match[2].toUpperCase(),
  };
}

function parseMerchant(text) {
  const recipient = text.match(/Betalningsmottagare\s*:\s*([^,\n.]+)/i);

  if (recipient) {
    return recipient[1].trim();
  }

  const receipt = text.match(/Kvitto\s+från\s+([^\n.]+)/i);
  return receipt?.[1].trim() ?? null;
}

export function parseReceipt(text, overrides = {}) {
  const money = parseMoney(text);
  const receipt = {
    amount: overrides.amount ? Number(overrides.amount) : money.amount,
    currency: overrides.currency?.toUpperCase() ?? money.currency,
    date: overrides.date ?? parseDate(text),
    merchant: overrides.merchant ?? parseMerchant(text),
  };

  if (!Number.isFinite(receipt.amount) || receipt.amount <= 0) {
    throw new Error("Could not extract a positive amount; use --amount");
  }

  if (!receipt.currency) {
    throw new Error("Could not extract the currency; use --currency");
  }

  if (!/^20\d{2}-\d{2}-\d{2}$/.test(receipt.date ?? "")) {
    throw new Error("Could not extract the receipt date; use --date");
  }

  if (!receipt.merchant) {
    throw new Error("Could not extract the merchant; use --merchant");
  }

  return receipt;
}

function deterministicUuid(buffer) {
  const bytes = createHash("sha256").update(buffer).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function normalize(value) {
  return value.toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
}

function slugify(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function uniqueWordToken(item, items, label) {
  const words = slugify(label(item))
    .split("-")
    .filter((word) => word.length >= 3 && !TOKEN_STOP_WORDS.has(word));

  return words.find((word) => (
    items.filter((candidate) => slugify(label(candidate)).split("-").includes(word))
      .length === 1
  ));
}

export function catalogEntries(items, label, overrides = new Map()) {
  return items.map((item) => {
    const name = label(item).trim();
    const token = overrides.get(name)
      ?? uniqueWordToken(item, items, label)
      ?? slugify(name);

    return {item, name, token};
  });
}

export function selectUnique(items, query, label, kind) {
  const needle = normalize(query);
  const exact = items.filter((item) => normalize(label(item)) === needle);
  const matches = exact.length > 0
    ? exact
    : items.filter((item) => normalize(label(item)).includes(needle));

  if (matches.length === 0) {
    throw new Error(`No ${kind} matched "${query}"`);
  }

  if (matches.length > 1) {
    const names = matches.map(label).join(", ");
    throw new Error(`Multiple ${kind} values matched "${query}": ${names}`);
  }

  return matches[0];
}

function selectCatalogEntry(entries, query, kind) {
  const needle = normalize(query);
  const tokenMatches = entries.filter((entry) => normalize(entry.token) === needle);

  if (tokenMatches.length === 1) {
    return tokenMatches[0];
  }

  const item = selectUnique(
    entries,
    query,
    (entry) => entry.name,
    kind,
  );

  return item;
}

function formatCatalog(entries) {
  const width = Math.max("TOKEN".length, ...entries.map((entry) => entry.token.length));
  const lines = [
    `${"TOKEN".padEnd(width)}  NAME`,
    `${"-".repeat(width)}  ${"-".repeat(4)}`,
    ...entries.map((entry) => `${entry.token.padEnd(width)}  ${entry.name}`),
  ];

  return `${lines.join("\n")}\n`;
}

function countryEntries() {
  return Object.entries(isoCountries.getNames("en", {select: "official"}))
    .map(([code, name]) => ({
      item: code,
      name,
      token: code.toLocaleLowerCase("en"),
    }))
    .sort((left, right) => left.token.localeCompare(right.token));
}

function formatExpense(summary, {dryRun, expenseId}) {
  const rows = [
    ["Primary PDF", summary.primaryPdf],
    ["Merchant", summary.merchant],
    ["Amount", `${summary.amount} ${summary.currency}`],
    ["Receipt date", summary.receiptDate],
    ["Accounting date", summary.accountingDate],
    ["Category", summary.category],
    ["Project", summary.project],
    ["Country", summary.country],
    ["PDF files", String(summary.pdfFiles)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  const heading = dryRun
    ? "Dry run — nothing was created"
    : `Expense created: ${expenseId}`;
  const lines = [
    heading,
    "",
    ...rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`),
  ];

  if (dryRun) {
    lines.push("", "Repeat with --submit to create this expense.");
  } else {
    lines.push(
      "",
      `${summary.pdfFiles} PDF ${summary.pdfFiles === 1 ? "was" : "were"} uploaded successfully.`,
    );
  }

  return `${lines.join("\n")}\n`;
}

async function capturePleoSession(browser) {
  const existingPages = await browser.pages();
  const page = await browser.newPage({background: true});

  try {
    await page.goto(PLEO_APP_URL, {waitUntil: "domcontentloaded"});
    const companyId = await page.evaluate(
      () => localStorage.getItem("@pleo/companyId"),
    );

    if (!companyId) {
      throw new Error("Pleo did not expose an active company ID");
    }

    const accessToken = await page.evaluate(async (activeCompanyId) => {
      const response = await fetch(
        `https://auth.pleo.io/sca/session?companyId=${activeCompanyId}`,
        {credentials: "include"},
      );

      if (!response.ok) {
        throw new Error(`Pleo authentication returned ${response.status}`);
      }

      const session = await response.json();
      return session.accessToken;
    }, companyId);

    if (!accessToken) {
      throw new Error("Pleo did not return an access token");
    }

    let bffOrigin = null;

    for (const candidate of [...existingPages, page]) {
      if (!candidate.url().startsWith("https://app.pleo.io/")) {
        continue;
      }

      const resource = await candidate.evaluate(() => (
        performance.getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((url) => url.includes("product-web-v2-bff.pleo.io"))
      ));

      if (resource) {
        bffOrigin = new URL(resource).origin;
        break;
      }
    }

    if (!bffOrigin) {
      throw new Error("Open Pleo once so the CLI can discover its API endpoint");
    }

    return {
      authorization: `Bearer ${accessToken}`,
      bffOrigin,
      companyId,
    };
  } finally {
    await page.close();
  }
}

async function requestJson(url, {authorization, body, method = "GET"}) {
  const response = await fetch(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      accept: "application/json",
      authorization,
      ...(body === undefined ? {} : {"content-type": "application/json"}),
      referer: "https://app.pleo.io/",
    },
    method,
  });
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new Error(`${method} ${url} returned ${response.status}: ${text}`);
  }

  return data;
}

function trpcData(response, batched = false) {
  const result = batched ? response?.[0] : response;
  return result?.result?.data;
}

async function fetchCategories(session) {
  const url = [
    "https://api.pleo.io/rest/v1/companies",
    session.companyId,
    "account-categories?eager=true&sortBy=createdAt&order=DESC",
  ].join("/");
  const categories = await requestJson(url, {
    authorization: session.authorization,
  });

  return categories
    .filter((category) => !category.hidden && category.selectable)
    .flatMap((category) => category.accounts ?? [])
    .filter((account) => !account.hidden && account.name.trim());
}

async function fetchProjectGroup(session) {
  const input = encodeURIComponent(JSON.stringify({
    tagGroupSettingsDrawer: false,
    tagTableDisplayName: false,
  }));
  const response = await requestJson(
    `${session.bffOrigin}/expenses.tagGroups.getAvailableTagGroups?input=${input}`,
    {authorization: session.authorization},
  );
  const groups = trpcData(response);
  const group = groups.find(
    (candidate) => (
      candidate.code === "projects"
      || normalize(candidate.name).includes("project")
    ),
  );

  if (!group) {
    throw new Error("Pleo did not return a project tag group");
  }

  return group;
}

async function resolveExpenseFields(session, options, receipt) {
  const headers = {authorization: session.authorization};
  const [detailsResponse, accounts, projectGroup, allowedResponse] =
    await Promise.all([
      requestJson(
        `${session.bffOrigin}/expenses.addExpense.getAddOutOfPocketExpenseDetails?batch=1&input=%7B%7D`,
        headers,
      ),
      fetchCategories(session),
      fetchProjectGroup(session),
      requestJson(
        `${session.bffOrigin}/expenses.addExpense.getExpenseAllowedFrom?input=%7B%7D`,
        headers,
      ),
    ]);
  const details = trpcData(detailsResponse, true);
  const categoryEntry = selectCatalogEntry(
    catalogEntries(accounts, (account) => account.name),
    options.category,
    "category",
  );
  const projectEntry = selectCatalogEntry(
    catalogEntries(projectGroup.tags, (tag) => tag.label),
    options.project,
    "project",
  );
  const allowedFrom = trpcData(allowedResponse).slice(0, 10);
  const accountingDate = receipt.date < allowedFrom ? allowedFrom : receipt.date;
  const country = options.country
    ? selectCatalogEntry(countryEntries(), options.country, "country").item
    : details.company.country;

  return {
    accountingDate,
    allowedFrom,
    category: categoryEntry.item,
    company: details.company,
    country,
    project: projectEntry.item,
    projectGroup,
  };
}

async function createExpense(session, data) {
  const response = await requestJson(
    `${session.bffOrigin}/expenses.addExpense.createOutOfPocketExpense?batch=1`,
    {
      authorization: session.authorization,
      body: {0: data},
      method: "POST",
    },
  );
  const created = trpcData(response, true);

  if (!created?.accountingEntryId) {
    throw new Error("Pleo did not return an accounting entry ID");
  }

  return created;
}

async function uploadReceipt(session, accountingEntryId, buffer, mimeType) {
  const url = [
    "https://api.pleo.io/rest/v6/accounting-entries",
    accountingEntryId,
    "receipts?source=USER",
  ].join("/");
  const response = await fetch(url, {
    body: buffer,
    headers: {
      accept: "application/json",
      authorization: session.authorization,
      "content-type": mimeType,
      referer: "https://app.pleo.io/",
    },
    method: "POST",
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Receipt upload returned ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

function validateOptions(options) {
  if (!options.receipts?.length) {
    throw new Error("At least one receipt path is required");
  }

  if (!options.project) {
    throw new Error(
      "A project token is required in the filename or with --project",
    );
  }

  if (!options.category) {
    throw new Error(
      "A category token is required in the filename or with --category",
    );
  }

  const invalidFiles = options.receipts.filter(
    (path) => !path.toLocaleLowerCase("en").endsWith(".pdf"),
  );

  if (invalidFiles.length > 0) {
    throw new Error(`Only PDF files are supported: ${invalidFiles.join(", ")}`);
  }
}

function validateBrowser() {
  if (!process.env.HOST_BROWSER_URL || !process.env.HOST_BROWSER_TOKEN) {
    throw new Error("The host browser environment is unavailable");
  }
}

async function prepareExpense(session, parsedOptions) {
  const filenameOptions = parseReceiptFilename(parsedOptions.receipts[0]) ?? {};
  const options = {
    ...filenameOptions,
    ...parsedOptions,
  };

  validateOptions(options);

  const receiptBuffers = await Promise.all(
    options.receipts.map((path) => readFile(path)),
  );
  const receiptBuffer = receiptBuffers[0];
  const receiptText = await extractPdfText(receiptBuffer);
  const receipt = parseReceipt(receiptText, options);
  const resolved = await resolveExpenseFields(session, options, receipt);
  const summary = {
    accountingDate: resolved.accountingDate,
    amount: receipt.amount,
    category: resolved.category.name.trim(),
    country: resolved.country,
    currency: receipt.currency,
    merchant: receipt.merchant,
    pdfFiles: options.receipts.length,
    primaryPdf: basename(options.receipts[0]),
    project: resolved.project.label,
    receiptDate: receipt.date,
  };

  return {
    options,
    receipt,
    receiptBuffer,
    receiptBuffers,
    resolved,
    summary,
  };
}

async function submitExpense(session, prepared) {
  const {
    options,
    receipt,
    receiptBuffer,
    receiptBuffers,
    resolved,
    summary,
  } = prepared;

  const expense = await createExpense(session, {
    accountId: resolved.category.id,
    amount: {
      currency: receipt.currency,
      value: receipt.amount,
    },
    attendees: [],
    idempotencyKey: deterministicUuid(receiptBuffer),
    merchantAddress: {
      country: resolved.country,
    },
    merchantName: receipt.merchant,
    note: options.note ?? null,
    performed: `${resolved.accountingDate}T12:00:00.000Z`,
    tagGroups: [{
      groupId: resolved.projectGroup.id,
      rowId: resolved.project.value,
    }],
  });
  let uploaded = 0;

  for (let index = 0; index < receiptBuffers.length; index += 1) {
    try {
      await uploadReceipt(
        session,
        expense.accountingEntryId,
        receiptBuffers[index],
        "application/pdf",
      );
      uploaded += 1;
    } catch (error) {
      throw new Error([
        `Expense ${expense.accountingEntryId} was created`,
        `${uploaded}/${receiptBuffers.length} PDFs were uploaded`,
        `${basename(options.receipts[index])} failed: ${error.message}`,
      ].join(", "));
    }
  }

  return {
    dryRun: false,
    expenseId: expense.accountingEntryId,
    receiptsUploaded: uploaded,
    summary,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const parsedOptions = parseArgs(argv);

  if (parsedOptions.help) {
    process.stdout.write(usage());
    return;
  }

  if (parsedOptions.command === "countries") {
    const entries = countryEntries();
    process.stdout.write(parsedOptions.json
      ? `${JSON.stringify(entries.map(({name, token}) => ({name, token})), null, 2)}\n`
      : formatCatalog(entries));
    return;
  }

  const receiptGroups = parsedOptions.command === "expense"
    ? await expandReceiptGroups(parsedOptions.receipts)
    : null;

  validateBrowser();
  const browser = await puppeteer.connect({
    browserURL: process.env.HOST_BROWSER_URL,
    wsOptions: {
      headers: {Authorization: `Bearer ${process.env.HOST_BROWSER_TOKEN}`},
    },
  });

  try {
    const session = await capturePleoSession(browser);

    if (parsedOptions.command === "categories") {
      const accounts = await fetchCategories(session);
      const entries = catalogEntries(
        accounts,
        (account) => account.name,
      ).sort((left, right) => left.token.localeCompare(right.token));

      process.stdout.write(parsedOptions.json
        ? `${JSON.stringify(entries.map(({name, token}) => ({name, token})), null, 2)}\n`
        : formatCatalog(entries));
      return;
    }

    if (parsedOptions.command === "projects") {
      const projectGroup = await fetchProjectGroup(session);
      const entries = catalogEntries(
        projectGroup.tags,
        (tag) => tag.label,
      ).sort((left, right) => left.token.localeCompare(right.token));

      process.stdout.write(parsedOptions.json
        ? `${JSON.stringify(entries.map(({name, token}) => ({name, token})), null, 2)}\n`
        : formatCatalog(entries));
      return;
    }

    const preparedExpenses = [];

    for (const receipts of receiptGroups) {
      preparedExpenses.push(await prepareExpense(session, {
        ...parsedOptions,
        receipts,
      }));
    }

    const results = [];

    for (const prepared of preparedExpenses) {
      const result = parsedOptions.submit
        ? await submitExpense(session, prepared)
        : {dryRun: true, summary: prepared.summary};
      results.push(result);

      if (!parsedOptions.json) {
        process.stdout.write(formatExpense(result.summary, {
          dryRun: result.dryRun,
          expenseId: result.expenseId,
        }));

        if (preparedExpenses.length > 1) {
          process.stdout.write("\n");
        }
      }
    }

    if (parsedOptions.json) {
      const output = results.map((result) => ({
        dryRun: result.dryRun,
        ...(result.expenseId ? {expenseId: result.expenseId} : {}),
        ...(result.receiptsUploaded === undefined
          ? {}
          : {receiptsUploaded: result.receiptsUploaded}),
        ...result.summary,
      }));

      process.stdout.write(`${JSON.stringify(
        output.length === 1 ? output[0] : output,
        null,
        2,
      )}\n`);
    }
  } finally {
    await browser.disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({at: "error", message: error.message})}\n`);
    process.exitCode = 1;
  });
}
