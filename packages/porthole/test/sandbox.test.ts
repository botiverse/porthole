import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { DOOR_SANDBOX_TOKENS } from "../src/compile/policy.ts";

describe("every sandbox Porthole writes", () => {
  test("statically: allow-same-origin is named only where the frame is the content origin's own", () => {
    // Every place in the source that sets a sandbox, and every literal sandbox list.
    // allow-same-origin is in exactly the two lists for a frame on an origin of its own (domain,
    // external), and in no other code.
    const root = path.resolve(import.meta.dirname, "../src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
          files.push(full);
        }
      }
    };
    walk(root);
    const found: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const line of lines) {
        // Code, not prose: comments say the name freely.
        const code = line
          .replace(/\/\*.*?\*\//gu, "")
          .replace(/\/\/.*$/u, "")
          .replace(/^\s*(\/\*\*|\*).*$/u, "");
        if (code.includes("allow-same-origin")) {
          found.push(`${path.relative(root, file)}: ${code.trim()}`);
        }
      }
    }
    expect(found, "allow-same-origin appears only where it is reviewed").toEqual([
      // sandboxTokens: a frame on an origin of its own, a separate site (domain: the content's;
      // external: a running app), P016, P099.
      'compile/policy.ts: return ["allow-scripts", "allow-same-origin"];',
      'compile/policy.ts: return ["allow-scripts", "allow-same-origin", "allow-forms", ...(config.sandbox ?? [])];',
      // The conformance runner's foreign page, which frames a content origin as an attacker would.
      expect.stringMatching(
        /^conformance\/host-kit\.ts: body: `<!doctype html><title>Foreign<\/title>/u,
      ),
    ]);
    // And every attribute write takes a value from these, never a literal of its own. Since
    // 0.16.0 (P149) the host's page is the only one that makes a frame: no document Porthole
    // serves frames another.
    const writes = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /setAttribute\(\s*"sandbox"/u.test(line))
        .map((line) => `${path.relative(root, file)}: ${line.trim()}`),
    );
    expect(writes).toEqual([
      'platform/web.ts: frame.setAttribute("sandbox", spec.sandbox);',
      // A served display's door (P125): scripts alone, from its own list.
      'platform/web.ts: frame.setAttribute("sandbox", DOOR_SANDBOX_TOKENS.join(" "));',
    ]);
    expect(DOOR_SANDBOX_TOKENS).toEqual(["allow-scripts"]);
    // The door frame has no name (P125): nothing can target it (`window.open(url, name)`, a link's or
    // a form's `target`), so the only window that can say the door's word is the one the host made.
    const web = readFileSync(path.join(root, "platform/web.ts"), "utf8");
    const createDoor = web.slice(web.indexOf("  createDoor("));
    expect(createDoor.length, "createDoor is in platform/web.ts").toBeLessThan(web.length);
    const code = createDoor
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/u, "").replace(/^\s*(\/\*\*|\*).*$/u, ""))
      .join("\n");
    expect(code, "the door sets no name attribute").not.toMatch(/setAttribute\(\s*["']name["']/u);
    // Every platform in the source makes its doors with the web platform's own (P125, P125-6): a
    // platform that wraps createSurface without them would refuse every served display, and one
    // with doors of its own would escape the checks above.
    const platforms = files.filter((file) => {
      const text = readFileSync(file, "utf8");
      // A platform's own createSurface (a method with a body), never a call or the interface's.
      return (
        /(?<![.\w])createSurface\(container[^)]*\)\s*(?::\s*\w+\s*)?\{/u.test(text) &&
        !file.endsWith("platform/web.ts")
      );
    });
    expect(
      platforms.map((file) => path.relative(root, file)),
      "the platforms that wrap the web's",
    ).toEqual(["check/page.ts"]);
    for (const file of platforms) {
      expect(
        readFileSync(file, "utf8"),
        `${path.relative(root, file)} makes the web's doors`,
      ).toMatch(/createDoor: \(container, spec\) => webPlatform\.createDoor!\(container, spec\)/u);
    }
    expect(code, "the door sets no name property").not.toMatch(/\.name\s*=(?!=)/u);
  });
});
