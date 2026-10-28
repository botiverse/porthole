import { expect, test } from "@playwright/test";
import { show } from "./nested-pages.ts";

/**
 * Workers in a nested page (P111, after the CTO's follow-up #85): the page is an opaque origin at
 * its sealed address, and every script below the prefix carries a CSP sandbox (d165926). What
 * starts, and answers: a dedicated worker from a script of the page's own set and a module one
 * (refused everywhere: a worker's script must be its creator's origin), a worker from a Blob URL,
 * one that imports a script of the set, and a Blob module worker (refused by Chromium in an opaque
 * document). Every outcome is the same with the scripts' sandbox taken out (measured with the
 * `file-sandbox` control): the sandbox refuses no worker. Untraced, as the other nested cases.
 */

test.use({ trace: "off" });

const FILES = {
  "worker.js": 'onmessage = (event) => postMessage("pong:" + event.data);',
  "module.js":
    'import { answer } from "./answer.js"; onmessage = (event) => postMessage(answer(event.data));',
  "answer.js": 'export const answer = (data) => "module:" + data;',
  "lib.js": 'self.answer = (data) => "lib:" + data;',
};

const SCRIPT = `
  const tried = (kind, make) => {
    let worker;
    try {
      worker = make();
    } catch (error) {
      say("worker", { kind, value: "threw:" + (error && error.name) });
      return;
    }
    const late = setTimeout(() => say("worker", { kind, value: "no answer" }), 5000);
    worker.onmessage = (event) => { clearTimeout(late); say("worker", { kind, value: "ok:" + event.data }); };
    worker.onerror = (event) => { clearTimeout(late); event.preventDefault(); say("worker", { kind, value: "error" }); };
    worker.postMessage("ping");
  };
  const here = (name) => new URL(name, document.baseURI).href;
  const blob = (text, type) => URL.createObjectURL(new Blob([text], { type: type || "text/javascript" }));
  tried("file", () => new Worker(here("worker.js")));
  tried("module", () => new Worker(here("module.js"), { type: "module" }));
  tried("blob", () => new Worker(blob('onmessage = (event) => postMessage("blob:" + event.data);')));
  tried("blob-import", () => new Worker(blob('importScripts(' + JSON.stringify(here("lib.js")) + '); onmessage = (event) => postMessage(self.answer(event.data));')));
  tried("blob-module-plain", () => new Worker(blob('onmessage = (event) => postMessage("plain:" + event.data);'), { type: "module" }));
  tried("blob-module", () => new Worker(blob('import { answer } from ' + JSON.stringify(here("answer.js")) + '; onmessage = (event) => postMessage(answer(event.data));'), { type: "module" }));
`;

test.describe("a nested page's workers (P111)", () => {
  test.setTimeout(60_000);

  test("what starts and answers: a set's script, a module, a Blob, a Blob that imports the set's", async ({
    page,
    browserName,
  }, info) => {
    const shown = await show(page, SCRIPT, undefined, FILES);
    const kinds = ["file", "module", "blob", "blob-import", "blob-module", "blob-module-plain"];
    await expect
      .poll(() => shown.said.filter((each) => each.type === "worker").length, { timeout: 15_000 })
      .toBe(kinds.length);
    const outcome = Object.fromEntries(
      shown.said
        .filter((each) => each.type === "worker")
        .map((each) => [String(each.kind), String(each.value)]),
    );
    // What each engine did, for the record (P111's table).
    await info.attach("workers", {
      body: JSON.stringify(outcome, null, 2),
      contentType: "application/json",
    });
    // A worker's script must be its creator's origin, and a nested page's is opaque: a worker from
    // a script of its own set is refused on every engine, by design, with or without the sandbox
    // on the script's answer (measured: the same with it taken out, control `file-sandbox`).
    expect(outcome.file, "a set's script as a worker: refused").not.toMatch(/^ok:/u);
    expect(outcome.module, "a set's module as a worker: refused").not.toMatch(/^ok:/u);
    // What a nested page does instead: a worker from a Blob URL, which may load the set's scripts.
    expect(outcome.blob, "a Blob worker starts and answers").toBe("ok:blob:ping");
    expect(outcome["blob-import"], "a Blob worker imports a script of the set").toBe("ok:lib:ping");
    if (browserName === "chromium") {
      // Chromium refuses a module worker from a Blob URL in an opaque document, one that imports
      // nothing included: no script's answer is involved (measured).
      expect(outcome["blob-module-plain"], "Chromium: a Blob module worker, refused").not.toMatch(
        /^ok:/u,
      );
    } else {
      expect(outcome["blob-module-plain"], "a Blob module worker starts").toBe("ok:plain:ping");
      expect(outcome["blob-module"], "a Blob module worker imports a module of the set").toBe(
        "ok:module:ping",
      );
    }
  });
});
