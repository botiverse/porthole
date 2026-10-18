// The runtime's types as a page uses them: compiled by `pnpm typecheck`, never shipped.
async function page(): Promise<void> {
  const db = await porthole.use("db");
  if (db === null) {
    return;
  }
  const snapshot = await db.get("votes/ada");
  await db.set("votes/ada", { choice: "b" }, { ifVersion: snapshot.version });
  const stop = db.onSnapshot("votes", (state) => void state);
  stop();
  const assets = await porthole.use("assets");
  const uploaded = await assets?.upload(new Blob(["x"]), { name: "a.png" });
  void uploaded?.url;
  const user = await porthole.use("user");
  const me = await user?.get();
  void me?.level;
  const artifact = await porthole.use("artifact");
  const current = await artifact?.get();
  if (artifact && current) {
    await artifact.publish({ base: current.version, files: { "index.html": "<!doctype html>" } });
  }
  try {
    await (await porthole.use("comments"))?.open({ name: "slide-3" });
  } catch (error) {
    void (error as PortholeError).code;
  }
}
void page;
