/**
 * Moves focus into one of the host page's own text fields (a composer that opens beside a
 * display): `field.focus()` for a host to call instead. Firefox doesn't move focus out of a frame
 * that holds it with a gesture of the person's, and takes it back on its own blur (measured: the
 * keys then go on to the frame); so where a frame of the page holds the focus, it is blurred
 * first. Elsewhere it is `field.focus()`.
 *
 * Nothing watches what happens next: until 0.16.0 a focus guard did, and counted a frame that
 * took the focus back toward stopping its display (P109, removed by P149).
 */
export function focusField(field: HTMLElement): void {
  const holder = field.ownerDocument.activeElement;
  const view = field.ownerDocument.defaultView;
  if (view !== null && holder instanceof view.HTMLIFrameElement) {
    holder.blur();
  }
  field.focus({ preventScroll: true });
}
