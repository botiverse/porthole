import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The server's secrets, derived from the one it is given: one key per use, so a value made for
 * one (a label) can never stand in for another (a cookie's signature).
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Lowercase base32 (RFC 4648 alphabet, no padding): DNS-safe, case-insensitive. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return out;
}

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** JSON with object keys in a fixed order, so equal values always serialize alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, each]) => each !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${canonicalJson(each)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface Keys {
  /** The DNS label for a storage scope: 24 base32 characters (120 bits), stable, not guessable. */
  label(scope: string): string;
  /** A short name for an instance (16 base32 characters): its document's path and cookie name. */
  instanceKey(instance: unknown): string;
  /** `value` signed: `<payload>.<signature>`, both base64url. */
  sign(value: unknown): string;
  /** The signed value, or null when the signature doesn't hold. */
  verify(token: string): unknown;
}

export function createKeys(secret: Uint8Array): Keys {
  if (secret.byteLength < 32) {
    throw new TypeError("The server's secret must be at least 32 random bytes");
  }
  const derive = (use: string): Buffer =>
    createHmac("sha256", secret).update(`porthole/${use}`).digest();
  const labelKey = derive("label");
  const instanceKey = derive("instance");
  const signKey = derive("session");
  const mac = (key: Buffer, text: string): Buffer =>
    createHmac("sha256", key).update(text).digest();

  return {
    label: (scope) => base32(mac(labelKey, scope).subarray(0, 15)),
    instanceKey: (instance) => base32(mac(instanceKey, canonicalJson(instance)).subarray(0, 10)),
    sign: (value) => {
      const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
      return `${payload}.${base64url(mac(signKey, payload))}`;
    },
    verify: (token) => {
      const [payload, signature, ...rest] = token.split(".");
      if (payload === undefined || signature === undefined || rest.length > 0) {
        return null;
      }
      const expected = mac(signKey, payload);
      const given = Buffer.from(signature, "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return null;
      }
      try {
        return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
      } catch {
        return null;
      }
    },
  };
}

/** A fresh one-time ticket: 160 random bits. */
export const newTicket = (): string => `pt_${base32(randomBytes(20))}`;

/** What a ticket is stored under: its hash, so a leaked store holds no usable ticket. */
export const ticketId = (ticket: string): string =>
  createHash("sha256").update(ticket).digest("base64url");
