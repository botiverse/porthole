#!/usr/bin/env node
/**
 * `npx porthole <command>`: the setup steps an adopter would otherwise script (P071).
 *
 *   porthole secret                  a new PORTHOLE_SECRET (32 random bytes, base64url)
 *   porthole d1-schema [table]       the D1 ticket table's SQL, for a migration file
 *                                    (npx porthole d1-schema > migrations/0001_porthole_tickets.sql)
 */
import { d1TicketSchema } from "./server/tickets.ts";

const USAGE = `Usage: porthole <command>

  secret              Print a new PORTHOLE_SECRET: 32 random bytes, base64url.
                      wrangler secret put PORTHOLE_SECRET, or your platform's secret store.
  d1-schema [table]   Print the D1 ticket table's SQL (default table porthole_tickets):
                      npx porthole d1-schema > migrations/0001_porthole_tickets.sql
`;

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** Runs one command; returns what to print and the exit code. */
export function run(args: readonly string[]): { readonly out: string; readonly code: number } {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "secret":
        return { out: `${base64url(crypto.getRandomValues(new Uint8Array(32)))}\n`, code: 0 };
      case "d1-schema":
        return { out: `${d1TicketSchema(rest[0])}\n`, code: 0 };
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return { out: USAGE, code: command === undefined ? 1 : 0 };
      default:
        return { out: `Unknown command ${JSON.stringify(command)}.\n\n${USAGE}`, code: 1 };
    }
  } catch (error) {
    return { out: `${error instanceof Error ? error.message : String(error)}\n`, code: 1 };
  }
}

// Run as a program (`porthole …`), not when imported (its test).
if (import.meta.main) {
  const { out, code } = run(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(out);
  process.exitCode = code;
}
