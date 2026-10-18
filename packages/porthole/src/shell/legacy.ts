/**
 * The legacy path (P085): the globals pages written for Porthole 0.5 and 0.6 call
 * (`sendPrompt`, `copyText`, `openLink`, `readData`, `subscribeData`), spliced into the shell's
 * runtime (`__LEGACY__`) for each capability the config declares, as before. A page written for the
 * capability runtime reaches the same host functions through `porthole.use` instead; the bridge
 * gates both paths alike, and holds a page that declared capabilities to its declaration on
 * either (P086).
 *
 * Since 0.7.0. Remove when no host serves a page written before it (hosts migrate their stored
 * pages' calls to `porthole.use`); until then the manual teaches these only where the config has
 * no runtime.
 */
export const LEGACY_GLOBALS_RUNTIME = String.raw`
  if (declared("sendPrompt")) {
    lock(window, "sendPrompt", (text) => {
      if (!gestured("sendPrompt")) {
        return refuse("sendPrompt needs a click: call it from a button's handler");
      }
      const words = String(text);
      if (words.trim() === "" || words.length > plan.maxPromptChars) {
        return refuse("sendPrompt takes 1 to " + plan.maxPromptChars + " characters");
      }
      return request("ui/message", { role: "user", content: [{ type: "text", text: words }] }).then(
        (result) => !(result && result.isError),
      );
    });
  }
  if (declared("copyText")) {
    lock(window, "copyText", (text) => {
      if (!gestured("copyText")) {
        return refuse("copyText needs a click: call it from a button's handler");
      }
      const words = String(text);
      if (words === "" || words.length > plan.maxCopyChars) {
        return refuse("copyText takes 1 to " + plan.maxCopyChars + " characters");
      }
      return request("porthole/copy-text", { text: words }).then((result) => !(result && result.isError));
    });
  }
  if (declared("openLink")) {
    lock(window, "openLink", (url) => {
      if (!gestured("openLink")) {
        return refuse("openLink needs a click: call it from a link's or button's handler");
      }
      return request("ui/open-link", { url: String(url) }).then((result) => !(result && result.isError));
    });
  }

  if (declared("readData")) {
    lock(window, "readData", readValue);
  }
  if (follow !== null) {
    lock(window, "subscribeData", follow);
  }
`;

/** The globals the legacy path defines, by the capability that defines each. */
export const LEGACY_GLOBALS = {
  sendPrompt: "sendPrompt",
  copyText: "copyText",
  openLink: "openLink",
  readData: "readData",
  subscribeData: "subscribeData",
} as const;
