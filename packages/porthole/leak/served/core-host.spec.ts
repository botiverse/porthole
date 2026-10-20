import { test } from "@playwright/test";
import {
  servedTests,
  type ServedConformanceHost,
  type ServedDisplay,
} from "../../src/conformance/served.ts";
import { configOf, harness, servedHost } from "./harness.ts";
import { mount } from "./porthole-host.ts";

/**
 * The served shell cases against a host on Porthole's own `createHost`, whose frames take their
 * content's height, as a React host's do: an empty shell is 0 px tall, so the cases that click
 * in it pass only because the suite gives it content and the host sends it (0.1.4, item 10).
 */
const coreHost: ServedConformanceHost = {
  ...servedHost,
  name: "createHost",
  async show(page, instance, options = {}): Promise<ServedDisplay> {
    const served = await harness();
    const location = await served.porthole.issue(instance, { viewer: "probe" });
    const shown = await mount(
      page,
      served.hostOrigin,
      configOf(served, instance),
      location,
      instance,
      options.content === undefined ? {} : { content: options.content },
    );
    return {
      origin: location.origin,
      async frame() {
        const frame = await shown.frame();
        await frame.waitForURL((url) => url.origin === location.origin);
        await frame.waitForLoadState("load");
        return frame;
      },
      destroy: () => Promise.resolve(),
      post: () => Promise.reject(new Error("createHost speaks to its frames itself")),
      received: () => Promise.reject(new Error("createHost speaks to its frames itself")),
    };
  },
};

const OTHERS = "the reference serving runs these; this host shows the shell and artifact cases";

test.describe(`served modes (${coreHost.name})`, () => {
  const skip = Object.fromEntries(
    [
      "served.url.origin",
      "served.url.no-reach",
      "served.url.no-top-navigation",
      "served.url.no-popups",
      "served.url.ticket",
      "served.url.tab",
      "served.url.framed",
      "served.url.siblings",
      "served.proxy.view",
      "served.proxy.parent-only",
      "served.proxy.egress",
    ].map((id) => [id, OTHERS]),
  );
  for (const each of servedTests(coreHost, { skip })) {
    test(each.title, ({ page, browserName }, info) => each.run({ page, browserName }, info));
  }
});
