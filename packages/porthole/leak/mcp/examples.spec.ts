import { expect, test, type Page } from "@playwright/test";
import { mountExample, type Mode } from "./examples.ts";

/**
 * The official ext-apps examples, unmodified, through Porthole's MCP Apps adapter (OBJECTIVE 3):
 * each renders its tool's input and result and interacts with its host, in an opaque frame
 * hardened by the shell and behind the sandbox proxy on a served origin.
 */

const SERVER_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u;

/**
 * Whether the engine has WebGL here: the threejs example needs it, and headless Firefox has none
 * on a machine without a GPU (measured, Mesa installed or not). Where it has none, those cases are
 * about the machine, not Porthole, so they are skipped with this reason rather than failed.
 */
async function webgl(page: Page): Promise<boolean> {
  return page.evaluate(() => document.createElement("canvas").getContext("webgl") !== null);
}
const NO_WEBGL =
  "measured: this engine has no WebGL on this machine (the threejs example needs it)";

for (const mode of ["opaque", "proxy"] as const satisfies readonly Mode[]) {
  test.describe(`MCP Apps examples (${mode})`, () => {
    test("basic-server-vanillajs: result, tool calls, message, link, theme, size, teardown", async ({
      page,
    }) => {
      const view = await mountExample(page, "vanillajs", mode);
      const result = await view.server.rpc("tools/call", { name: "get-time", arguments: {} });
      await view.send("sendToolInput", {});
      await view.send("sendToolResult", result);
      const time = view.frame.locator("#server-time");
      await expect(time).toHaveText((result.structuredContent as { time: string }).time);

      await view.frame.locator("#get-time-btn").click();
      await expect(time).not.toHaveText((result.structuredContent as { time: string }).time);
      await expect(time).toHaveText(SERVER_TIME);

      await view.frame.locator("#message-text").fill("Hello from the view");
      await view.frame.locator("#send-message-btn").click();
      await view.frame.locator("#link-url").fill("https://example.com/porthole");
      await view.frame.locator("#open-link-btn").click();
      await view.frame.locator("#log-text").fill("just a log");
      await view.frame.locator("#send-log-btn").click();
      await expect
        .poll(async () =>
          (await view.calls())
            .filter((call) => call.capability !== "resize")
            .map((call) => [call.capability, call.args]),
        )
        .toEqual([
          ["callTool", { name: "get-time", arguments: {} }],
          ["sendPrompt", { text: "Hello from the view" }],
          ["openLink", { url: "https://example.com/porthole" }],
        ]);
      expect((await view.calls()).some((call) => call.capability === "resize")).toBe(true);
      // Measured, not asserted (P021: the host's check holds only where the engine passes a
      // frame's gesture up): whether the host page saw a gesture with each clicked call.
      test.info().annotations.push({
        type: "host activation on a click in the view",
        description: JSON.stringify(
          (await view.calls())
            .filter((call) => call.capability !== "resize")
            .map((call) => [call.capability, call.userActivated]),
        ),
      });

      await page.evaluate((index) => window.mcpHost.setTheme(index, "dark"), view.index);
      await expect(view.frame.locator("html")).toHaveAttribute("data-theme", "dark");

      await page.evaluate((index) => window.mcpHost.teardown(index), view.index);
    });

    test("basic-server-react: result, tool calls, message, link", async ({ page }) => {
      const view = await mountExample(page, "react", mode);
      const result = await view.server.rpc("tools/call", { name: "get-time", arguments: {} });
      await view.send("sendToolInput", {});
      await view.send("sendToolResult", result);
      // This one carries the time as text content only.
      const first = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      const time = view.frame.locator("code");
      await expect(time).toHaveText(first);

      await view.frame.getByRole("button", { name: "Get Server Time" }).click();
      await expect(time).not.toHaveText(first);
      await view.frame.locator("textarea").fill("Hello from React");
      await view.frame.getByRole("button", { name: "Send Message" }).click();
      await view.frame.locator('input[type="url"]').fill("https://example.com/react");
      await view.frame.getByRole("button", { name: "Open Link" }).click();
      await expect
        .poll(async () =>
          (await view.calls())
            .filter((call) => call.capability !== "resize")
            .map((call) => [call.capability, call.args]),
        )
        .toEqual([
          ["callTool", { name: "get-time", arguments: {} }],
          ["sendPrompt", { text: "Hello from React" }],
          ["openLink", { url: "https://example.com/react" }],
        ]);
    });

    test("threejs-server: streamed input, a rendered scene, errors into the model context", async ({
      page,
    }) => {
      test.skip(!(await webgl(page)), NO_WEBGL);
      const view = await mountExample(page, "threejs", mode);
      const code = [
        "const scene = new THREE.Scene();",
        "const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);",
        "camera.position.z = 3;",
        "const renderer = new THREE.WebGLRenderer({ canvas, alpha: true });",
        "renderer.setSize(width, height, false);",
        "scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial()));",
        "renderer.render(scene, camera);",
        "canvas.dataset.rendered = 'yes';",
      ].join("\n");
      await view.send("sendToolInputPartial", { code: code.slice(0, 40) });
      await view.send("sendToolInputPartial", { code: code.slice(0, 120) });
      await view.send("sendToolInput", { code, height: 240 });
      await view.send(
        "sendToolResult",
        await view.server.rpc("tools/call", {
          name: "show_threejs_scene",
          arguments: { code, height: 240 },
        }),
      );
      await expect(view.frame.locator("#threejs-canvas")).toHaveAttribute("data-rendered", "yes", {
        timeout: 15_000,
      });
    });

    test("threejs-server: a scene that throws reaches the model context", async ({ page }) => {
      test.skip(!(await webgl(page)), NO_WEBGL);
      const view = await mountExample(page, "threejs", mode);
      await view.send("sendToolInput", { code: "throw new Error('the scene broke')", height: 200 });
      await expect
        .poll(
          async () =>
            (await view.calls()).find((call) => call.capability === "setModelContext")?.args,
          { timeout: 15_000 },
        )
        .toMatchObject({
          structuredContent: {
            type: "scene_error",
            error: expect.stringContaining("the scene broke"),
          },
        });
    });
  });
}
