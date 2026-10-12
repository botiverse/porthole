import { describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { d1TicketSchema } from "../src/server/index.ts";

/** `npx porthole`: a secret, and the D1 migration (P071). */
describe("the porthole command", () => {
  it("prints a fresh 32-byte secret each time", () => {
    const one = run(["secret"]);
    const two = run(["secret"]);
    expect(one.code).toBe(0);
    expect(one.out.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(one.out).not.toBe(two.out);
  });

  it("prints the D1 ticket schema, for a migration file", () => {
    expect(run(["d1-schema"])).toEqual({ out: `${d1TicketSchema()}\n`, code: 0 });
    expect(run(["d1-schema", "my_tickets"]).out).toContain("CREATE TABLE IF NOT EXISTS my_tickets");
    expect(run(["d1-schema", "bad name"]).code).toBe(1);
  });

  it("says how to use it", () => {
    expect(run([]).code).toBe(1);
    expect(run(["help"]).out).toContain("d1-schema");
    expect(run(["nope"]).out).toContain('Unknown command "nope"');
  });
});
