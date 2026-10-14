import { readFileSync } from "node:fs";

/**
 * Docker/compose secrets support: for each name below, if `<NAME>_FILE` is set and `<NAME>` is not,
 * read the file (e.g. /run/secrets/anthropic_api_key) into `process.env.<NAME>`.
 * Imported first in server.ts so it runs before anything reads the environment.
 */
const SECRET_VARS = ["ANTHROPIC_API_KEY", "HA_TOKEN", "WEBHOOK_USER", "WEBHOOK_PASSWORD"];

for (const name of SECRET_VARS) {
  const file = process.env[`${name}_FILE`];
  if (!file || process.env[name]) continue;
  try {
    process.env[name] = readFileSync(file, "utf8").trim();
  } catch (err) {
    throw new Error(`Cannot read ${name}_FILE=${file}: ${(err as Error).message}`);
  }
}
