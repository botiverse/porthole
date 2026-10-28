import { describe, expect, test } from "vitest";
import { LIBRARY_CDNS, mayPassOn, presets, type PageDeclaration } from "../src/index.ts";

/**
 * `mayPassOn` (P112): "a page with a channel gets no drafts", as a function a host can call. Each
 * channel alone makes it true; without one, false.
 */

const offering = (extra: Parameters<typeof presets.artifact>[0] = {}) =>
  presets.artifact({
    runtime: "1",
    capabilities: { comments: {}, user: {}, db: {} },
    egress: LIBRARY_CDNS,
    ...extra,
  });
const declaring = (capabilities: PageDeclaration["capabilities"]): PageDeclaration => ({
  capabilities,
  runtime: "1",
});

describe("mayPassOn (P112)", () => {
  test("no channel: the built-ins, the library CDNs, db or user alone", () => {
    expect(mayPassOn(offering(), declaring({}))).toBe(false);
    expect(mayPassOn(offering(), null)).toBe(false);
    expect(mayPassOn(offering(), declaring({ db: {} }))).toBe(false);
    expect(mayPassOn(offering(), declaring({ user: {} }))).toBe(false);
  });

  test("db and user, both declared and offered: it can keep what others read, knowing whose", () => {
    expect(mayPassOn(offering(), declaring({ db: {}, user: {} }))).toBe(true);
    // Declared but not offered: the page can't reach them.
    const without = presets.artifact({ runtime: "1", capabilities: { comments: {}, user: {} } });
    expect(mayPassOn(without, declaring({ db: {}, user: {} }))).toBe(false);
  });

  test("the network beyond the library CDNs: a connection, any https site, an origin the host added", () => {
    expect(mayPassOn(offering({ egress: { connect: ["https://api.example.com"] } }), null)).toBe(
      true,
    );
    expect(mayPassOn(offering({ egress: { anyHttps: ["img"] } }), null)).toBe(true);
    expect(mayPassOn(offering({ egress: { img: ["https://images.example.com"] } }), null)).toBe(
      true,
    );
    expect(
      mayPassOn(
        offering({ capabilities: { readData: { connect: ["https://data.example.com"] } } }),
        null,
      ),
    ).toBe(true);
  });
});
