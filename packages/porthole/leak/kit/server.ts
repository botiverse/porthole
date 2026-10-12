import { startKit } from "./app.ts";

/**
 * The kit reference app as a process (`node leak/kit/server.ts`), configured as a deployment is:
 * PORTHOLE_KIT_PORT, PORTHOLE_KIT_APP_ORIGIN, PORTHOLE_KIT_CONTENT_DOMAIN, PORTHOLE_KIT_SECRET,
 * PORTHOLE_KIT_HEALTH (0: no health gate, so settings that can't be served throw at startup),
 * PORTHOLE_KIT_LISTEN.
 */
const port = Number(process.env.PORTHOLE_KIT_PORT ?? 8798);
const kit = await startKit({
  port,
  appOrigin: process.env.PORTHOLE_KIT_APP_ORIGIN ?? `http://localhost:${port}`,
  contentDomain: process.env.PORTHOLE_KIT_CONTENT_DOMAIN ?? `kitcontent.localhost:${port}`,
  ...(process.env.PORTHOLE_KIT_SECRET === undefined
    ? {}
    : { secret: process.env.PORTHOLE_KIT_SECRET }),
  health: process.env.PORTHOLE_KIT_HEALTH !== "0",
  listen: process.env.PORTHOLE_KIT_LISTEN ?? "127.0.0.1",
});
console.log(JSON.stringify({ evt: "kit.listening", port, meta: kit.content.meta() }));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    kit.close();
    process.exit(0);
  });
}
