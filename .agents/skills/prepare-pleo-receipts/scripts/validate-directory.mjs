#!/usr/bin/env node

import {access} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import process from "node:process";
import {fileURLToPath, pathToFileURL} from "node:url";

function fail(message) {
  process.stderr.write(`at=error message=${JSON.stringify(message)}\n`);
  process.exitCode = 1;
}

const [directory, ...extraArguments] = process.argv.slice(2);

if (!directory || extraArguments.length > 0) {
  fail("usage: validate-directory.mjs DIRECTORY");
} else {
  try {
    const scriptDirectory = dirname(fileURLToPath(import.meta.url));
    const repository = resolve(scriptDirectory, "../../../..");
    const expenseModule = resolve(repository, "pleo-expense.mjs");

    await access(expenseModule);

    const {discoverReceiptGroups, parseReceiptFilename} = await import(
      pathToFileURL(expenseModule)
    );
    const groups = await discoverReceiptGroups(resolve(directory));
    let fileCount = 0;

    for (const group of groups) {
      const metadata = parseReceiptFilename(group[0]);

      if (!metadata) {
        throw new Error(`Could not parse primary receipt: ${group[0]}`);
      }

      if (metadata.currency !== "SEK") {
        throw new Error(`Filename amount is not in SEK: ${group[0]}`);
      }

      fileCount += group.length;
      process.stdout.write(
        `at=info date=${metadata.date}`
        + ` merchant=${JSON.stringify(metadata.merchant)}`
        + ` amount_sek=${metadata.amount.toFixed(2)}`
        + ` files=${group.length}\n`,
      );
    }

    process.stdout.write(
      `at=info message="validation complete" groups=${groups.length}`
      + ` files=${fileCount}\n`,
    );
  } catch (error) {
    fail(error.message);
  }
}
