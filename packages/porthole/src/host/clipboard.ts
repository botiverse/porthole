/**
 * Writing the clipboard from the host's page, for a `copyText` handler (P052): content never
 * writes it itself (P051). The person's click in the frame gives the host's page user activation
 * (it propagates to ancestors; measured on Chromium, WebKit and Firefox), which the write needs.
 */

/**
 * Writes `text` to the clipboard: the async Clipboard API, else a selected text area and the copy
 * command. Resolves whether it worked; it can fail without a recent gesture, so a host shows the
 * text either way (and offers its own Copy button when it failed).
 */
export async function writeClipboard(text: string, document: Document): Promise<boolean> {
  const view = document.defaultView;
  try {
    if (view?.navigator.clipboard !== undefined) {
      await view.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the copy command.
  }
  const focused = document.activeElement;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;padding:0";
  try {
    document.body.append(area);
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (focused !== null && typeof (focused as HTMLElement).focus === "function") {
      (focused as HTMLElement).focus({ preventScroll: true });
    }
  }
}
