import { createHash, createHmac, randomBytes as nodeRandom } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  base64url,
  fromBase64url,
  hmacSha256,
  randomBytes,
  sha256,
  timingSafeEqual,
  utf8,
} from "../src/server/crypto.ts";

/** `/server`'s own hashing (P044) against the standard vectors and `node:crypto`. */

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const unhex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "hex"));

describe("sha256", () => {
  test.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("NIST vector %j", (input, digest) => {
    expect(hex(sha256(utf8(input)))).toBe(digest);
  });

  test("a million 'a's", () => {
    expect(hex(sha256(new Uint8Array(1_000_000).fill(0x61)))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  test("agrees with node:crypto on every length around the block edges, and random data", () => {
    for (let length = 0; length < 200; length += 1) {
      const data = new Uint8Array(nodeRandom(length));
      expect(hex(sha256(data)), `length ${length}`).toBe(
        createHash("sha256").update(data).digest("hex"),
      );
    }
  });
});

describe("hmacSha256", () => {
  test.each([
    // RFC 4231 test cases 1, 2, 6 (a key longer than a block), 7.
    [
      "0b".repeat(20),
      utf8("Hi There"),
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    ],
    [
      hex(utf8("Jefe")),
      utf8("what do ya want for nothing?"),
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    ],
    [
      "aa".repeat(131),
      utf8("Test Using Larger Than Block-Size Key - Hash Key First"),
      "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
    ],
    [
      "aa".repeat(131),
      utf8(
        "This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.",
      ),
      "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
    ],
  ])("RFC 4231 vector", (key, data, digest) => {
    expect(hex(hmacSha256(unhex(key), data))).toBe(digest);
  });

  test("agrees with node:crypto", () => {
    for (let index = 0; index < 50; index += 1) {
      const key = new Uint8Array(nodeRandom(index * 3));
      const data = new Uint8Array(nodeRandom(index * 7));
      expect(hex(hmacSha256(key, data))).toBe(createHmac("sha256", key).update(data).digest("hex"));
    }
  });
});

describe("base64url and the rest", () => {
  test("round-trips, agrees with Buffer, refuses non-canonical input", () => {
    for (let length = 0; length < 40; length += 1) {
      const data = new Uint8Array(nodeRandom(length));
      const encoded = base64url(data);
      expect(encoded).toBe(Buffer.from(data).toString("base64url"));
      expect(fromBase64url(encoded)).toEqual(data);
    }
    expect(fromBase64url("a")).toBeNull();
    expect(fromBase64url("ab+c")).toBeNull();
    expect(fromBase64url("ab=")).toBeNull();
    expect(fromBase64url("AB")).toBeNull();
  });

  test("timing-safe equality and random bytes", () => {
    expect(timingSafeEqual(utf8("abc"), utf8("abc"))).toBe(true);
    expect(timingSafeEqual(utf8("abc"), utf8("abd"))).toBe(false);
    expect(timingSafeEqual(utf8("abc"), utf8("ab"))).toBe(false);
    expect(randomBytes(20)).toHaveLength(20);
    expect(hex(randomBytes(20))).not.toBe(hex(randomBytes(20)));
  });
});
