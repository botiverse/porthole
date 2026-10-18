import { hmacSha256, utf8 } from "./crypto.ts";
import { base32 } from "./keys.ts";

/**
 * A person's id for one artifact's pages (P087, after the review): what `Grant.user.id` may be
 * where pages shouldn't learn the account id or link one person across artifacts. Stable for the
 * same secret, artifact and person (their `data/users/<id>` stays theirs across visits), a
 * different one on every other artifact, not reversible without the secret. 26 lowercase base32
 * characters: one db path segment. The secret is the host's (at least 32 random bytes); keep it
 * apart from Porthole's server secret.
 */
export function pseudonymFor(secret: Uint8Array, artifact: string, person: string): string {
  if (!(secret instanceof Uint8Array) || secret.length < 32) {
    throw new TypeError("pseudonymFor needs a secret of at least 32 random bytes");
  }
  if (artifact === "" || person === "") {
    throw new TypeError("pseudonymFor needs an artifact and a person");
  }
  const mac = hmacSha256(secret, utf8(`porthole/pseudonym\u0000${artifact}\u0000${person}`));
  return base32(mac.slice(0, 16)).slice(0, 26);
}
