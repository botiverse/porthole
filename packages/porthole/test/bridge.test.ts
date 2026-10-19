import { describe, expect, test } from "vitest";
import { createBridge, linkTarget, type BridgeEvent } from "../src/bridge/bridge.ts";
import type {
  CapabilityHandlers,
  ConfirmAnswer,
  ConfirmRequest,
  Proceed,
} from "../src/bridge/types.ts";
import { presets, type PresetOptions } from "../src/index.ts";

/** A bridge over a preset, recording its events, the handler calls and the confirmations asked. */
function setup(
  options: PresetOptions,
  extra: {
    confirm?: (request: ConfirmRequest, proceed: Proceed) => Promise<ConfirmAnswer>;
    activation?: boolean;
    handlers?: CapabilityHandlers;
  } = {},
) {
  const events: BridgeEvent[] = [];
  const handled: { capability: string; args: unknown }[] = [];
  const asked: ConfirmRequest[] = [];
  let now = 0;
  const bridge = createBridge({
    config: presets.inlineWidget(options),
    display: { id: "d1", title: "Chart" },
    handlers: extra.handlers ?? {
      sendPrompt: (args) => {
        handled.push({ capability: "sendPrompt", args });
        return true;
      },
      openLink: (args) => {
        handled.push({ capability: "openLink", args });
        return true;
      },
      callTool: (args) => {
        handled.push({ capability: "callTool", args });
        return { content: [] };
      },
    },
    ...(extra.confirm === undefined
      ? {}
      : {
          confirm: (request: ConfirmRequest, proceed: Proceed) => {
            asked.push(request);
            return extra.confirm?.(request, proceed) ?? Promise.resolve(false);
          },
        }),
    userActivation: () => extra.activation,
    onEvent: (event) => events.push(event),
    now: () => now,
  });
  return { bridge, events, handled, asked, advance: (ms: number) => (now += ms) };
}

const accept = () => Promise.resolve(true);
const decline = () => Promise.resolve(false);

describe("the bridge's order: declared → rate → valid → muted → gesture → confirm → handler", () => {
  test("an undeclared capability is refused before anything else", async () => {
    const { bridge, handled, asked } = setup({}, { confirm: accept });
    expect(await bridge.call("sendPrompt", { text: "hi" })).toEqual({
      ok: false,
      refusal: "not-declared",
      reason: { code: "not_allowed", message: "This isn't available here." },
    });
    expect(handled).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("malformed arguments are refused before a person is asked", async () => {
    const { bridge, asked } = setup(
      { capabilities: { sendPrompt: {}, openLink: {} } },
      { confirm: accept },
    );
    for (const args of [
      {},
      { text: "" },
      { text: "   " },
      { text: 3 },
      null,
      "hi",
      { text: "x".repeat(8_001) },
    ]) {
      expect((await bridge.call("sendPrompt", args)).ok, JSON.stringify(args)).toBe(false);
    }
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "https://bank.example@evil.example/",
      "notaurl",
      "",
    ]) {
      expect(await bridge.call("openLink", { url })).toMatchObject({
        ok: false,
        refusal: "invalid",
      });
    }
    expect(asked).toEqual([]);
  });

  test("a confirm-gated call goes only if the person accepts, with the call's whole effect shown", async () => {
    const yes = setup({ capabilities: { sendPrompt: {} } }, { confirm: accept, activation: true });
    expect(await yes.bridge.call("sendPrompt", { text: "Explain March" })).toEqual({
      ok: true,
      value: true,
    });
    expect(yes.asked).toEqual([
      {
        capability: "sendPrompt",
        args: { text: "Explain March" },
        display: { id: "d1", title: "Chart" },
      },
    ]);
    expect(yes.handled).toEqual([{ capability: "sendPrompt", args: { text: "Explain March" } }]);

    const no = setup({ capabilities: { sendPrompt: {} } }, { confirm: decline, activation: true });
    expect(await no.bridge.call("sendPrompt", { text: "Explain March" })).toEqual({
      ok: false,
      refusal: "declined",
      reason: { code: "denied", message: "You didn't allow this." },
    });
    expect(no.handled).toEqual([]);
  });

  test("a confirm-gated call without a confirm function is refused: fail closed", async () => {
    const { bridge, handled } = setup({ capabilities: { sendPrompt: {} } }, { activation: true });
    expect(await bridge.call("sendPrompt", { text: "hi" })).toEqual({
      ok: false,
      refusal: "no-confirm",
      reason: { code: "not_allowed", message: "This isn't available here." },
    });
    expect(handled).toEqual([]);
  });

  test("a confirm function that throws counts as a decline", async () => {
    const { bridge, handled } = setup(
      { capabilities: { sendPrompt: {} } },
      { confirm: () => Promise.reject(new Error("dialog crashed")), activation: true },
    );
    expect(await bridge.call("sendPrompt", { text: "hi" })).toMatchObject({ refusal: "declined" });
    expect(handled).toEqual([]);
  });

  test("a gesture-gated call is refused when the host page says it has no user activation", async () => {
    const { bridge, asked } = setup(
      { capabilities: { openLink: {} } },
      { confirm: accept, activation: false },
    );
    expect(await bridge.call("openLink", { url: "https://example.com" })).toMatchObject({
      refusal: "no-user-activation",
    });
    expect(asked).toEqual([]);
  });

  test("where the platform can't tell (undefined), the gesture is left to the shell", async () => {
    const { bridge, handled } = setup({ capabilities: { openLink: {} } }, { confirm: accept });
    expect((await bridge.call("openLink", { url: "https://example.com/a?b#c" })).ok).toBe(true);
    expect(handled).toEqual([
      { capability: "openLink", args: { url: "https://example.com/a?b#c" } },
    ]);
  });

  test("declines mute the display after the limit: it stops asking until it runs again", async () => {
    const { bridge, events, asked } = setup(
      { capabilities: { sendPrompt: {} }, limits: { declinesBeforeMute: 2 } },
      { confirm: decline, activation: true },
    );
    await bridge.call("sendPrompt", { text: "1" });
    await bridge.call("sendPrompt", { text: "2" });
    expect(events.filter((event) => event.type === "muted")).toHaveLength(1);
    expect(await bridge.call("sendPrompt", { text: "3" })).toMatchObject({ refusal: "muted" });
    expect(asked).toHaveLength(2);
  });

  test("only declines in a row mute: a yes starts the count again", async () => {
    const answers = [false, true, false, false, false];
    const { bridge, events } = setup(
      { capabilities: { sendPrompt: {} }, limits: { declinesBeforeMute: 3 } },
      { confirm: () => Promise.resolve(answers.shift() ?? false), activation: true },
    );
    for (let index = 0; index < 4; index += 1) {
      await bridge.call("sendPrompt", { text: `${index}` });
    }
    expect(
      events.some((event) => event.type === "muted"),
      "muted after 1 + 2 declines",
    ).toBe(false);
    await bridge.call("sendPrompt", { text: "4" });
    expect(events.filter((event) => event.type === "muted")).toHaveLength(1);
  });

  test("a redirected answer (edit first) sends nothing and neither counts nor resets", async () => {
    const answers: ConfirmAnswer[] = ["declined", "redirected", "redirected", "declined"];
    const { bridge, events, handled } = setup(
      { capabilities: { sendPrompt: {} }, limits: { declinesBeforeMute: 2 } },
      { confirm: () => Promise.resolve(answers.shift() ?? false), activation: true },
    );
    expect(await bridge.call("sendPrompt", { text: "a" })).toMatchObject({ refusal: "declined" });
    expect(await bridge.call("sendPrompt", { text: "b" })).toMatchObject({ refusal: "redirected" });
    expect(await bridge.call("sendPrompt", { text: "c" })).toMatchObject({ refusal: "redirected" });
    expect(events.some((event) => event.type === "muted")).toBe(false);
    await bridge.call("sendPrompt", { text: "d" });
    expect(
      events.some((event) => event.type === "muted"),
      "two declines, not in between yeses",
    ).toBe(true);
    expect(handled).toEqual([]);
  });

  test("proceed runs the effect inside the confirm call itself, once, and counts as yes", async () => {
    let inside = false;
    let ranInside = false;
    let runs = 0;
    const { bridge } = setup(
      { capabilities: { openLink: {} } },
      {
        activation: true,
        handlers: {
          openLink: () => {
            runs += 1;
            ranInside = inside;
            return true;
          },
        },
        confirm: (_request, proceed) => {
          inside = true;
          proceed();
          inside = false;
          // The answer after proceed doesn't undo it.
          return Promise.resolve(false);
        },
      },
    );
    expect(await bridge.call("openLink", { url: "https://example.com" })).toEqual({
      ok: true,
      value: true,
    });
    expect({ runs, ranInside }).toEqual({ runs: 1, ranInside: true });
  });

  test("a rate limit refuses calls past it within a minute, and frees up after", async () => {
    const { bridge, advance } = setup({
      capabilities: { openLink: { gates: [{ rateLimit: { perMinute: 2 } }] } },
    });
    expect((await bridge.call("openLink", { url: "https://a.example" })).ok).toBe(true);
    expect((await bridge.call("openLink", { url: "https://a.example" })).ok).toBe(true);
    expect(await bridge.call("openLink", { url: "https://a.example" })).toMatchObject({
      refusal: "rate-limited",
    });
    advance(60_001);
    expect((await bridge.call("openLink", { url: "https://a.example" })).ok).toBe(true);
  });

  test("an explicitly ungated capability runs without asking", async () => {
    const { bridge, asked, handled } = setup(
      { capabilities: { openLink: { gates: [] } } },
      { activation: false },
    );
    expect((await bridge.call("openLink", { url: "https://a.example" })).ok).toBe(true);
    expect(asked).toEqual([]);
    expect(handled).toHaveLength(1);
  });

  test("a handler that throws is a refusal the frame can see, not a crash", async () => {
    const { bridge } = setup(
      { capabilities: { callTool: {} } },
      {
        confirm: accept,
        handlers: {
          callTool: () => {
            throw new Error("tool server down");
          },
        },
      },
    );
    // The handler's words stay the host's: content is told Porthole's (P080).
    expect(await bridge.call("callTool", { name: "x" })).toEqual({
      ok: false,
      refusal: "failed",
      message: "tool server down",
      reason: { code: "failed", message: "The app couldn't do this." },
    });
  });

  test("sizes and errors become events, clamped and cut, never handler calls", async () => {
    const { bridge, events } = setup({});
    await bridge.call("resize", { height: 412.5, width: 300 });
    await bridge.call("resize", { height: -1 });
    await bridge.call("reportError", { message: "x".repeat(3_000) });
    expect(events[0]).toEqual({ type: "resize", height: 412.5, width: 300 });
    expect(events[1]).toEqual({ type: "refused", capability: "resize", refusal: "invalid" });
    expect(events[2]).toMatchObject({ type: "error" });
    expect((events[2] as { message: string }).message).toHaveLength(2_000);
  });

  test("error reports are rate limited (a loop that throws can't flood the host)", async () => {
    const { bridge, events } = setup({});
    for (let index = 0; index < 15; index += 1) {
      await bridge.call("reportError", { message: `e${index}` });
    }
    expect(events.filter((event) => event.type === "error")).toHaveLength(10);
  });
});

describe("linkTarget", () => {
  test("takes http(s) URLs and normalizes them", () => {
    expect(linkTarget("https://example.com")).toBe("https://example.com/");
    expect(linkTarget(" http://example.com/a b ")).toBe("http://example.com/a%20b");
  });
  test("refuses other schemes, credentials, and overlong URLs", () => {
    for (const url of [
      "javascript:x",
      "blob:https://a/b",
      "ftp://a",
      "https://u:p@a.example",
      `https://a.example/${"x".repeat(5_000)}`,
      42,
    ]) {
      expect(linkTarget(url)).toBeNull();
    }
  });
});
