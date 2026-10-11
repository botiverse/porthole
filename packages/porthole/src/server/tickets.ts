import type { TicketRecord, TicketStore } from "./types.ts";

/**
 * Tickets in this process's memory: right for one server process. A host that runs several
 * behind a load balancer passes a shared store (its database) whose `take` is atomic.
 */
export function memoryTicketStore(options: { readonly now?: () => number } = {}): TicketStore {
  const now = options.now ?? Date.now;
  const tickets = new Map<string, TicketRecord>();
  const sweep = (): void => {
    const at = now();
    for (const [id, record] of tickets) {
      if (record.expiresAt <= at) {
        tickets.delete(id);
      }
    }
  };
  return {
    put(id, record) {
      sweep();
      tickets.set(id, record);
      return Promise.resolve();
    },
    take(id) {
      const record = tickets.get(id);
      tickets.delete(id);
      return Promise.resolve(record !== undefined && record.expiresAt > now() ? record : null);
    },
  };
}

/**
 * The part of a Cloudflare D1 database (or any SQLite-like binding with the same shape) the ticket
 * store uses: a prepared statement, bound, run or read once.
 */
export interface D1Like {
  prepare(query: string): D1StatementLike;
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

const TABLE = /^[a-z_][a-z0-9_]{0,62}$/u;

/** The table a D1 ticket store needs (run once, as a migration). */
export function d1TicketSchema(table = "porthole_tickets"): string {
  if (!TABLE.test(table)) {
    throw new TypeError("A ticket table is named with a-z 0-9 _");
  }
  return `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, record TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ${table}_expires_at ON ${table} (expires_at);`;
}

/**
 * Tickets in a D1 database (P045): shared by every Worker isolate, and taken once by an atomic
 * `DELETE … RETURNING` (one statement on D1's single primary, so two requests racing for a ticket
 * can't both get it). Expired tickets are swept as new ones go in. Workers KV is no place for
 * tickets: it is eventually consistent, so a ticket read in two places could be used twice.
 */
export function d1TicketStore(
  db: D1Like,
  options: { readonly table?: string; readonly now?: () => number } = {},
): TicketStore {
  const table = options.table ?? "porthole_tickets";
  if (!TABLE.test(table)) {
    throw new TypeError("A ticket table is named with a-z 0-9 _");
  }
  const now = options.now ?? Date.now;
  return {
    async put(id, record) {
      await db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).bind(now()).run();
      await db
        .prepare(`INSERT INTO ${table} (id, record, expires_at) VALUES (?, ?, ?)`)
        .bind(id, JSON.stringify(record), record.expiresAt)
        .run();
    },
    async take(id) {
      const row = await db
        .prepare(`DELETE FROM ${table} WHERE id = ? RETURNING record, expires_at`)
        .bind(id)
        .first<{ record: string; expires_at: number }>();
      if (row === null || row.expires_at <= now()) {
        return null;
      }
      try {
        return JSON.parse(row.record) as TicketRecord;
      } catch {
        return null;
      }
    },
  };
}
