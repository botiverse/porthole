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
