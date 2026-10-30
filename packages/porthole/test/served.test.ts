import { describe, expect, it } from "vitest";
import {
  checkFrameLocation,
  maybeSameSite,
  originMatchesSource,
  parseOrigin,
} from "../src/isolation/served.ts";

describe("maybeSameSite", () => {
  it("errs toward same site", () => {
    expect(maybeSameSite("app.example.com", "x.usercontent.example.com")).toBe(true);
    expect(maybeSameSite("example.com", "example.com")).toBe(true);
    // A pair under one public suffix is refused, though browsers would call it cross-site.
    expect(maybeSameSite("a.github.io", "b.github.io")).toBe(true);
  });

  it("calls distinct registrable domains, IPs and localhost's subdomains cross-site", () => {
    expect(maybeSameSite("app.example.com", "x.example-usercontent.com")).toBe(false);
    expect(maybeSameSite("127.0.0.1", "abc.localhost")).toBe(false);
    expect(maybeSameSite("localhost", "abc.localhost")).toBe(false);
    expect(maybeSameSite("[::1]", "abc.localhost")).toBe(false);
  });
});

describe("originMatchesSource", () => {
  it("matches subdomains of a wildcard, on its scheme and port only", () => {
    expect(originMatchesSource("https://abc.cdn.com", "https://*.cdn.com")).toBe(true);
    expect(originMatchesSource("https://a.b.cdn.com", "https://*.cdn.com")).toBe(true);
    expect(originMatchesSource("https://cdn.com", "https://*.cdn.com")).toBe(false);
    expect(originMatchesSource("https://evilcdn.com", "https://*.cdn.com")).toBe(false);
    expect(originMatchesSource("http://abc.cdn.com", "https://*.cdn.com")).toBe(false);
    expect(originMatchesSource("http://abc.localhost:8790", "http://*.localhost:8790")).toBe(true);
    expect(originMatchesSource("http://abc.localhost:8791", "http://*.localhost:8790")).toBe(false);
    expect(originMatchesSource("https://abc.cdn.com:443", "https://*.cdn.com")).toBe(true);
  });

  it("matches an exact source exactly", () => {
    expect(originMatchesSource("https://app.dev", "https://app.dev")).toBe(true);
    expect(originMatchesSource("https://app.dev:444", "https://app.dev")).toBe(false);
  });

  it("parses only exact origins", () => {
    expect(parseOrigin("https://a.b/c")).toBeNull();
    expect(parseOrigin("https://A.b")).toBeNull();
    expect(parseOrigin("https://a.b")).toEqual({ scheme: "https", host: "a.b", port: "443" });
  });
});

describe("checkFrameLocation", () => {
  const sources = ["https://*.example-usercontent.com"];
  const host = "https://app.example.com";

  it("accepts a located frame on a content origin", () => {
    expect(() =>
      checkFrameLocation(
        {
          url: "https://abc.example-usercontent.com/__porthole/d/x?ticket=t",
          origin: "https://abc.example-usercontent.com",
        },
        sources,
        host,
      ),
    ).not.toThrow();
  });

  it("refuses a URL off its stated origin, an origin the config doesn't name, and the host's own site", () => {
    expect(() =>
      checkFrameLocation(
        { url: "https://evil.com/", origin: "https://abc.example-usercontent.com" },
        sources,
        host,
      ),
    ).toThrow(/not on its origin/u);
    expect(() =>
      checkFrameLocation(
        { url: "https://abc.other.com/", origin: "https://abc.other.com" },
        sources,
        host,
      ),
    ).toThrow(/content origins/u);
    expect(() =>
      checkFrameLocation(
        { url: "https://x.usercontent.example.com/", origin: "https://x.usercontent.example.com" },
        ["https://*.usercontent.example.com"],
        host,
      ),
    ).toThrow(/same site/u);
  });

  it("never quotes a located URL's ticket in its message (P071)", () => {
    let message = "";
    try {
      checkFrameLocation(
        {
          url: "https://evil.com/__porthole/d/x?ticket=pt_secret",
          origin: "https://abc.example-usercontent.com",
        },
        sources,
        host,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("https://evil.com");
    expect(message).not.toContain("pt_secret");
    expect(message).not.toContain("__porthole");
  });

  describe("a location's door (P125)", () => {
    const origin = "https://abc.example-usercontent.com";
    const at = (door: unknown) => ({
      url: `${origin}/__porthole/d/aaaaaaaaaaaaaaaa?ticket=t`,
      origin,
      door,
    });
    const check =
      (door: unknown, nested = false) =>
      () =>
        checkFrameLocation(at(door) as never, sources, host, nested);

    it("accepts a door on the display's own origin, at the door route", () => {
      expect(check({ url: `${origin}/__porthole/door/aaaaaaaaaaaaaaaa?ticket=d` })).not.toThrow();
    });

    it("the load-bearing check: a door on any other origin is refused, its path right or not", () => {
      // Another content origin of the same config, at the door route: still not this display's.
      expect(
        check({
          url: "https://other.example-usercontent.com/__porthole/door/aaaaaaaaaaaaaaaa?ticket=d",
        }),
      ).toThrow(/not on its location's origin/u);
      // Another port, another scheme: another origin.
      expect(
        check({
          url: "https://abc.example-usercontent.com:8443/__porthole/door/aaaaaaaaaaaaaaaa?ticket=d",
        }),
      ).toThrow(/not on its location's origin/u);
      expect(
        check({
          url: "http://abc.example-usercontent.com/__porthole/door/aaaaaaaaaaaaaaaa?ticket=d",
        }),
      ).toThrow(/not on its location's origin/u);
    });

    it("refuses a door elsewhere on the origin, one that isn't { url }, and any for a nested page", () => {
      expect(check({ url: `${origin}/__porthole/d/aaaaaaaaaaaaaaaa?ticket=d` })).toThrow(
        /not at \/__porthole\/door\//u,
      );
      expect(check("https://x")).toThrow(/not \{ url \}/u);
      // A nested page's shell, on its own label (P114): it is located with no door at all.
      const shell = `https://porthole-${"a".repeat(24)}.example-usercontent.com`;
      expect(() =>
        checkFrameLocation(
          {
            url: `${shell}/__porthole/d/aaaaaaaaaaaaaaaa?ticket=t`,
            origin: shell,
            door: { url: `${shell}/__porthole/door/aaaaaaaaaaaaaaaa?ticket=d` },
          },
          sources,
          host,
          true,
        ),
      ).toThrow(/nested page is located with no door/u);
    });

    it("never quotes the door's ticket in a refusal", () => {
      let message = "";
      try {
        check({
          url: "https://other.example-usercontent.com/__porthole/door/k?ticket=pt_secret",
        })();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("https://other.example-usercontent.com");
      expect(message).not.toContain("pt_secret");
    });
  });
});
