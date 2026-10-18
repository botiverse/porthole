import {
  base64url,
  fromBase64url,
  fromUtf8,
  hmacSha256,
  randomBytes,
  sha256,
  timingSafeEqual,
  utf8,
} from "./crypto.ts";

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
  /**
   * `value` sealed (AES-256-GCM, Web Crypto): unreadable and unforgeable without the secret,
   * base64url. A file set's access in a frame's path (P083), which content can read: the viewer
   * and the host's subject inside it stay the host's.
   */
  seal(value: unknown): Promise<string>;
  /** The sealed value, or null when it doesn't open. */
  unseal(token: string): Promise<unknown>;
}

/** What a sealed value is bound to, so it can never be taken for anything else sealed. */
const SEAL_CONTEXT = utf8("porthole/files");

export function createKeys(secret: Uint8Array): Keys {
  if (secret.byteLength < 32) {
    throw new TypeError("The server's secret must be at least 32 random bytes");
  }
  const derive = (use: string): Uint8Array => hmacSha256(secret, utf8(`porthole/${use}`));
  const labelKey = derive("label");
  const instanceKey = derive("instance");
  const signKey = derive("session");
  const sealKey = derive("files");
  let sealing: Promise<CryptoKey> | null = null;
  const sealingKey = (): Promise<CryptoKey> =>
    (sealing ??= crypto.subtle.importKey("raw", new Uint8Array(sealKey), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]));
  const mac = (key: Uint8Array, text: string): Uint8Array => hmacSha256(key, utf8(text));

  return {
    label: (scope) => base32(mac(labelKey, scope).subarray(0, 15)),
    instanceKey: (instance) => base32(mac(instanceKey, canonicalJson(instance)).subarray(0, 10)),
    sign: (value) => {
      const payload = base64url(utf8(JSON.stringify(value)));
      return `${payload}.${base64url(mac(signKey, payload))}`;
    },
    verify: (token) => {
      const [payload, signature, ...rest] = token.split(".");
      if (payload === undefined || signature === undefined || rest.length > 0) {
        return null;
      }
      const expected = mac(signKey, payload);
      const given = fromBase64url(signature);
      if (given === null || !timingSafeEqual(given, expected)) {
        return null;
      }
      const bytes = fromBase64url(payload);
      if (bytes === null) {
        return null;
      }
      try {
        return JSON.parse(fromUtf8(bytes)) as unknown;
      } catch {
        return null;
      }
    },
    seal: async (value) => {
      const iv = randomBytes(12);
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: new Uint8Array(iv), additionalData: new Uint8Array(SEAL_CONTEXT) },
          await sealingKey(),
          new Uint8Array(utf8(JSON.stringify(value))),
        ),
      );
      const token = new Uint8Array(iv.length + sealed.length);
      token.set(iv);
      token.set(sealed, iv.length);
      return base64url(token);
    },
    unseal: async (token) => {
      const bytes = token.length > 8_192 ? null : fromBase64url(token);
      // 12 bytes of IV and 16 of tag at least.
      if (bytes === null || bytes.length < 29) {
        return null;
      }
      try {
        const opened = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: new Uint8Array(bytes.subarray(0, 12)),
            additionalData: new Uint8Array(SEAL_CONTEXT),
          },
          await sealingKey(),
          new Uint8Array(bytes.subarray(12)),
        );
        return JSON.parse(fromUtf8(new Uint8Array(opened))) as unknown;
      } catch {
        return null;
      }
    },
  };
}

/** A fresh one-time ticket: 160 random bits. */
export const newTicket = (): string => `pt_${base32(randomBytes(20))}`;

/** What a ticket is stored under: its hash, so a leaked store holds no usable ticket. */
export const ticketId = (ticket: string): string => base64url(sha256(utf8(ticket)));
