import { inspect } from "node:util";

/** Debug logging, enabled with DEBUG=1 (see `npm run start-debug`). */
export const DEBUG = !!process.env.DEBUG && process.env.DEBUG !== "0";

const MAX_STRING = 2000;

export function debug(label: string, data?: unknown) {
  if (!DEBUG) return;
  const time = new Date().toISOString().slice(11, 23);
  if (data === undefined) return console.log(`[debug ${time}] ${label}`);
  const body = typeof data === "string" ? truncate(data) : inspect(data, { depth: 6, colors: true, maxStringLength: MAX_STRING });
  console.log(`[debug ${time}] ${label}\n${body}`);
}

function truncate(s: string): string {
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}... (${s.length - MAX_STRING} more chars)` : s;
}
