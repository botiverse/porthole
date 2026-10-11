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
});
