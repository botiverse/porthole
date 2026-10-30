/**
 * The negative controls (P032, P096): one registry of every control the suite has, each with the
 * specs it is checked by and the tests it must fail on each engine. `scripts/controls.ts` runs
 * them (in CI, a job per engine); `test/controls.test.ts` holds the registry to `WEAKENINGS` (every
 * weakening is run) and to DESIGN.md's table of controls (`controlsTable`), and the judge below to
 * synthetic runs: a run that didn't happen, or whose probes were skipped, never passes.
 */

export const ENGINES = ["chromium", "webkit", "firefox"] as const;
export type Engine = (typeof ENGINES)[number];

/** A control: `PORTHOLE_LEAK_WEAKEN=<its name>` (one weakening, or several joined by commas). */
export interface Control {
  /** The spec files it is run with, relative to the package. */
  readonly specs: readonly string[];
  /**
   * The tests it must make fail on each engine, each named exactly (`names`): a probe's `[id]`, a
   * served case's id, or a test's whole title; a probe in two specs is a test in each. Every other
   * test of its specs must pass (or be skipped as it always is). An engine with none: the control
   * fails nothing there, which `holds` says why.
   */
  readonly fails: Readonly<Record<Engine, readonly string[]>>;
  /**
   * `fail`: every other test of its specs fails too (by an assertion or by timing out), and none
   * passes: the control takes out what all of them stand on (the shell, on a strict page without
   * the host's nonce). Its named tests still fail by their verdicts.
   */
  readonly others?: "fail";
  /**
   * Why it fails nothing on an engine where it names no test (every such control says, P096):
   * `by` a combined control that takes this one's walls out with another's and fails something
   * there (test/controls.test.ts checks both), or, without `by`, why no probe can see the wall
   * (`why` starts "no probe").
   */
  readonly holds?: { readonly why: string; readonly by?: string };
}

/**
 * The mark a probe's verdict carries: its deciding `expect`'s message starts with it (`expect(x,
 * "probe: …")`, `expect.poll(f, { message: "probe: …" })`). A control counts only a failure whose
 * error carries it, so a probe that failed in its setup (a page that didn't load, a positive
 * control) never counts as the wall seen to fail (P096, after its review).
 */
export const VERDICT = "probe: ";

/**
 * Whether a registry entry names a test (its own title, without its describe blocks): `[id]` is
 * the probe whose title starts with it and a space; a served case's id (`served.<mode>.<case>`)
 * the case whose title starts with it and a colon; anything else the test whose title it is.
 */
export function names(expected: string, title: string): boolean {
  if (/^\[[^\]]+\]$/.test(expected)) {
    return title.startsWith(`${expected} `);
  }
  if (/^served\.[a-z]+\.[a-z-]+$/.test(expected)) {
    return title.startsWith(`${expected}: `);
  }
  return title === expected;
}

/**
 * Specs no control is run with, each with the reason: their servers run Porthole without the
 * weakenings, so a control would take nothing out there and its probes would pass for the wrong
 * reason (after the audit: the kit's harness ignores PORTHOLE_LEAK_WEAKEN). The runner refuses a
 * control that names one; a control's probes that pass are a failure anyway (gone blind).
 */
export const UNWEAKENED: Readonly<Record<string, string>> = {
  "leak/kit.spec.ts":
    "the host kit's reference app (leak/kit/server.ts) runs Porthole from its sources in Node, where no weakening is applied; its walls are the core's, whose controls run against the leak and served harnesses",
};

const LEAK = "leak/leak.spec.ts";
const RUNTIME = "leak/served/runtime.spec.ts";
const NESTED = "leak/served/nested.spec.ts";
const NESTED_SIBLINGS = "leak/served/nested-siblings.spec.ts";
const STALL_RULE =
  "a shell's activation seen after a stall is no one's gesture until it goes off (P111, after its review)";
const FILES = "leak/served/files.spec.ts";
const SERVED = "leak/served/served.spec.ts";
const TAB = "leak/served/tab.spec.ts";
const OUTCOME = "leak/served/outcome.spec.ts";
const SIBLINGS_STATUS = "leak/served/siblings-status.spec.ts";
const ANNOTATE = "leak/annotate.spec.ts";

/** The keyboard's probes (P109). */
const TAKE =
  "a page that takes the keyboard while the person types in the host's composer gets a key or two at most, and is stopped";
const BLUR_TAKE =
  "a page that takes the keyboard back on its own blur keeps none of it: the composer keeps its words, and comments.open reaches no handler";
const FIELD_TAKE =
  "a composer the host focuses with focusField, beside a page with the person's gesture that takes focus back on its blur, gets their words";

/** A nested page's keyboard in a fight over the host's composer (P120). */
const NESTED_FIGHT =
  "a page that holds the keyboard from its load and takes it back on its own blur gets none of what the person types in the host's composer, and is stopped (P120)";

/** What the CSP sandbox alone holds on a tab (P099), every engine. */
const TAB_SANDBOX = [
  "served.domain.tab-escapes",
  "served.domain.tab-opener",
  "a file set's page on a tab of its own opens its own pages, and no window, link in a new window or download",
  "a frame's sealed address opened on a tab of its own is sandboxed as its frame is",
];

/**
 * WebKit throws on the probes' attack, a sibling's `document.open` into another display's loading
 * document (measured in CI on 2026-10-30, three runs, every attempt; a script appended to a loaded
 * one still runs, and other ways into a loading one are not measured): the probes whose attack is
 * that write skip there, with the measurement (`requireReach`), so no control can see their walls
 * on WebKit. Retest with each WebKit version: the probes measure it on every run and
 * run whole again once A can write.
 */
const WEBKIT_REFUSES_SIBLING_WRITE =
  "no probe on WebKit: the probes' attack, a sibling's document.open() into another display's loading document, throws there (measured in CI 2026-10-30, every attempt of three runs; other ways in are not measured), so [sibling-inject], [sibling-reload], [sibling-wipe] and [proxy] skip there with that measurement; retest with each WebKit version";

/** The same tests on every engine. */
function all(...tests: string[]): Control["fails"] {
  return { chromium: tests, webkit: tests, firefox: tests };
}

/** Each engine's tests: those of every engine, and each engine's own. */
function each(
  common: readonly string[],
  own: Partial<Record<Engine, readonly string[]>>,
): Control["fails"] {
  return {
    chromium: [...common, ...(own.chromium ?? [])],
    webkit: [...common, ...(own.webkit ?? [])],
    firefox: [...common, ...(own.firefox ?? [])],
  };
}

const NOTHING = all();

/** Titles named by more than one control; the link cases of a set's pages (P084, P098). */
const FRAMED_APP =
  "a framed app mid-session: its next request after revocation is denied, and its next load tells the host";
const FRAMED_PAGE =
  "a framed page mid-session: its next load after revocation is denied where the engine keeps its cookie";
const PUSHED_READ =
  "a read above the viewer's level: a result the host pushed is refused as a cold read is";
const TRUSTED_CODE =
  "a script asset runs as code only if an admin uploaded it where uploads are the admins'";
const FAKED_MARKER_CLICK =
  "a hostile page fakes a marker's click: the host takes it only for a mark it shows with a marker";
const MARKER_PRESS =
  "a marker's press, of any kind, moves nothing of the content's: no handler, no focus, no selection";
const PATCHED_PRESS =
  "a page that patches the event's built-ins neither hears a marker's press nor stops its report (P105)";
const MARKER_TAP =
  "a tap on a marker is reported on every engine, and the content hears none of it (P105)";
const HONEST_SCROLL =
  "an honest scroll session, long, in comment mode, leaves room for a marker's click: follow-ups, the selection's too, at most one a second";
const IN_SET_LINKS = [
  "a link to another page of the set opens it in the frame; the display goes on",
  "a link to another page of the set opens it in the frame when the leaving page's notice is dropped (P098)",
  "a link to another page of the set opens it in the frame when the leaving page's notice is late (P098)",
];

export const CONTROLS: Readonly<Record<string, Control>> = {
  // The shell runtime and the CSP, through the leak suite (DESIGN.md, items 1-13).
  // 14.silent's fetch rejects only while connect-src holds; 8.prefetch holds on Chromium too, by
  // the shell's hint guard (measured, 0.7.0).
  "connect-src": { specs: [LEAK], fails: all("[1.connect]", "[14.silent]") },
  webrtc: { specs: [LEAK], fails: all("[3.webrtc]", "[14.workers]") },
  // The frame guards are two walls: either alone is covered by the other.
  "frame-guard": {
    specs: [LEAK],
    fails: NOTHING,
    holds: {
      why: "the synchronous guard drops what the observer would",
      by: "frame-guard,sync-guard",
    },
  },
  "attach-shadow": {
    specs: [LEAK],
    fails: NOTHING,
    holds: {
      why: "the synchronous guard reaches a closed shadow root's frames as they connect",
      by: "attach-shadow,sync-guard",
    },
  },
  "sync-guard": {
    specs: [LEAK],
    fails: each([], { webkit: ["[8.preconnect]"] }),
    holds: {
      why: "on Chromium and Firefox the observer removes what the synchronous guard would, and no preconnect opens even unsandboxed (measured)",
      by: "frame-guard,sync-guard",
    },
  },
  "frame-guard,sync-guard": {
    specs: [LEAK],
    fails: each(
      [
        "[4.light-dom]",
        "[4.sync-realm]",
        "[4.plugins]",
        "[4.foreign-object]",
        "[4.template-clone]",
        "[7.base-plugins]",
        "[14.shell]",
      ],
      { webkit: ["[8.preconnect]"] },
    ),
  },
  "attach-shadow,sync-guard": {
    specs: [LEAK],
    fails: each(["[4.closed-shadow]", "[4.shadow-nested]"], { webkit: ["[8.preconnect]"] }),
  },
  "declarative-shadow": { specs: [LEAK], fails: all("[4.declarative-shadow]") },
  "parser-entry-points": { specs: [LEAK], fails: all("[4.document-write]", "[14.shell]") },
  // Firefox no longer holds 5.data by itself (Firefox 155; P035 measured it did).
  "embedder-csp": {
    specs: [LEAK],
    fails: all(
      "[5.location]",
      "[5.replace]",
      "[5.open-self]",
      "[5.anchor]",
      "[5.svg-link]",
      "[5.host-origin]",
      "[5.blob]",
      "[5.data]",
      "[6.remote-download]",
    ),
  },
  "embedder-self": { specs: [LEAK], fails: all("[5.host-origin]") },
  sandbox: {
    specs: [LEAK],
    fails: each(
      [
        "[6.open]",
        "[6.blank-link]",
        "[6.top]",
        "[6.top-link]",
        "[6.parent]",
        "[14.dialogs]",
        "[14.windows]",
      ],
      // WebKit prints nothing from a frame even with allow-modals (measured, 0.7.0).
      { chromium: ["[6.download]", "[14.print]"], firefox: ["[14.print]"] },
    ),
  },
  "base-uri": { specs: [LEAK], fails: all("[7.base-plugins]") },
  self: {
    specs: [LEAK],
    fails: NOTHING,
    holds: {
      why: "no probe can see it: an opaque frame's 'self' matches no origin, so 'self' in its CSP reaches nothing of the host on any engine (measured, P022); kept out because nothing needs it, and its run checks that it still opens nothing",
    },
  },
  "style-split": {
    specs: [LEAK],
    fails: all("[0.app-sdk-inline]", "[0.app-sdk-artifact]", "[0.app-sdk-mcp-app]"),
  },
  "draft-inert": { specs: [LEAK], fails: all("[11.streaming]") },
  "document-theme": { specs: [LEAK], fails: all("[11.document-theme]", "[14.theme-never]") },
  "confirm-gate": {
    specs: [LEAK],
    fails: all(
      "[12.prompt-gesture-confirm]",
      "[12.link]",
      "[12.mute]",
      "[12.no-confirm]",
      "[14.windows]",
    ),
  },
  "shell-gesture": {
    specs: [LEAK],
    fails: all("[12.prompt-gesture-confirm]", "[12.mute]", "[12.copy-text]"),
  },
  "host-gesture": { specs: [LEAK], fails: all("[12.raw-message]") },
  // The show gate (P100): a model context update reaches the handler unseen.
  "model-context-show": { specs: [LEAK], fails: all("[12.model-context]") },
  "link-scheme": { specs: [LEAK], fails: all("[12.link]") },
  clipboard: {
    specs: [LEAK],
    // Chromium holds the async API (and 14.shell's clipboard) by the frame's `allow` denial too.
    fails: each(["[13.clipboard-command]", "[13.clipboard-event]"], {
      webkit: ["[13.clipboard-api]", "[14.shell]"],
      firefox: ["[13.clipboard-api]", "[14.shell]"],
    }),
  },
  // What content logs, formatted as it came before the bridge's gate (P095, S05), on both host
  // pages; 14.silent reads the shell's blocked-load report as the text it was (measured).
  "report-unbounded": {
    specs: [LEAK, "leak/strict-csp.spec.ts"],
    fails: all("[14.error-shapes]", "[14.silent]"),
  },
  // A strict host page (P054): without the host's nonce the shell never runs, so nothing the
  // suite asks of it happens.
  nonce: {
    specs: ["leak/strict-csp.spec.ts"],
    fails: all("the shell runs on a host page whose script-src is its nonce alone (P054)"),
    others: "fail",
  },
  "annotation-checks": {
    specs: [ANNOTATE],
    fails: all(
      "a hostile page fakes reports: the host takes none it didn't ask for, nothing malformed, and not a flood",
    ),
  },
  // A marker's click (P104): the host's check of its id and count, and the shell keeping it from
  // content, trusted only.
  "annotation-activated": { specs: [ANNOTATE], fails: all(FAKED_MARKER_CLICK) },
  "annotation-activated-count": { specs: [ANNOTATE], fails: all(FAKED_MARKER_CLICK) },
  "marker-trusted": { specs: [ANNOTATE], fails: all(FAKED_MARKER_CLICK) },
  "marker-click": {
    specs: [ANNOTATE],
    fails: all(
      "markers: a mark with a count gets a numbered bubble; its click is reported and never reaches the content",
      MARKER_PRESS,
      PATCHED_PRESS,
      MARKER_TAP,
      // P107: a draft's and a posted marker's presses beside each other reach none of the content.
      "drafts (P107): a dashed line and a hollow marker with no number, apart from posted marks; their clicks are reported the same",
      // P119: a tap in a marker's 44 px box, the nearest of two, and a pinned marker's click and
      // tap are the marker's, so with the marker's click not taken they reach the content.
      "on touch, a marker takes a tap a few px off its bubble (44 by 44), after the page scrolled itself; a tap past that is the page's (P119)",
      "on touch, where two markers' 44 px boxes overlap, a tap is the nearest bubble's (P119)",
      "a paragraph's marker pinned at the frame's top once its start scrolled away takes a mouse click and a tap where it is drawn (P119, porthole#42)",
    ),
  },
  // After the review of P104 (P105): the press's default cancelled (focus on every engine; a
  // drag's selection on WebKit), read through the platform's own functions, follow-ups on one
  // clock and only while a mark has a marker, a marker's click only within a gesture.
  "marker-prevent": { specs: [ANNOTATE], fails: all(MARKER_PRESS) },
  "marker-place": {
    specs: [ANNOTATE],
    fails: all(
      "text markers cover no word: on a column page, and on a phone's lines with one marker each (P105, #36)",
    ),
  },
  "marker-tap": {
    specs: [ANNOTATE],
    // P119's touch probes tap a marker too, so on WebKit they fail with it.
    fails: each([], {
      webkit: [
        MARKER_TAP,
        "on touch, a marker takes a tap a few px off its bubble (44 by 44), after the page scrolled itself; a tap past that is the page's (P119)",
        "on touch, where two markers' 44 px boxes overlap, a tap is the nearest bubble's (P119)",
        "a paragraph's marker pinned at the frame's top once its start scrolled away takes a mouse click and a tap where it is drawn (P119, porthole#42)",
      ],
    }),
    holds: {
      why: "no probe can see it on Chromium and Firefox: they make a tap a click on the marker without a listener of its own (measured, P105)",
    },
  },
  "marker-originals": { specs: [ANNOTATE], fails: all(PATCHED_PRESS) },
  "follow-throttle": { specs: [ANNOTATE], fails: all(HONEST_SCROLL) },
  "selection-follow": { specs: [ANNOTATE], fails: all(HONEST_SCROLL) },
  "follow-count": {
    specs: [ANNOTATE],
    fails: all(
      "following: a host that gives no counts hears no follow-up after a scroll, as before markers",
    ),
  },
  // P107: the host drops a draft's count before the frame.
  "draft-count": {
    specs: [ANNOTATE],
    fails: all(
      "what the page reads of a draft (P107): that it is one, never its count; a posted mark as before",
    ),
  },
  "draft-shell-checks": {
    specs: [ANNOTATE],
    fails: all(
      "the shell's own checks on a raw show (P107): a draft draws no number, a kind it doesn't know is no mark",
    ),
  },
  "annotation-activated-gesture": {
    specs: [ANNOTATE],
    fails: all(
      "a hostile page's marker click with no gesture is dropped; one on the person's own press is the host's view to guard (P105)",
    ),
  },
  // The host clamps every reported box to the frame (P104); the two cases that read a mark below
  // the viewport see its box on the edge only through it.
  "annotation-rect-clamp": {
    specs: [ANNOTATE],
    fails: all(
      "a hostile page reports a box outside its frame: the host gets it clamped to the frame's viewport",
      "marks: drawn over their anchors, one brought into view, an unfound one orphaned, all cleared",
      "following: once a scroll settles, one report with only the marks that moved",
    ),
  },
  // Served content (leak/served/).
  authorize: {
    specs: ["leak/served/authorize.spec.ts"],
    fails: each(
      [
        "a revoked subject's ticket opens nothing: a page and an app are denied, and the host is told",
        "in a tab of its own, a revoked app and page are denied from the next request on",
        // A framed page's next run goes through a door with a fresh ticket (P125), on every engine:
        // without the host's check that door opens, WebKit included.
        FRAMED_PAGE,
      ],
      // WebKit keeps no cookie in a cross-site frame (P025): a framed app has no session to revoke.
      {
        chromium: [FRAMED_APP],
        firefox: [FRAMED_APP],
      },
    ),
  },
  "url-permissions": {
    specs: ["leak/served/permissions.spec.ts"],
    fails: all(
      "a url-mode frame gets no clipboard writes or full screen unless the host delegates them",
    ),
  },
  "navigate-guard": {
    specs: ["leak/served/live.spec.ts", FILES, SERVED, TAB],
    fails: all(
      "served.domain.self-navigation",
      "served.domain.tab-navigation",
      // A tab's links stand on the guard's rule too (measured: the outside site hears them).
      "served.domain.tab-links",
      ...["location", "replace", "open-self", "navigation-api"].map(
        (how) => `can't navigate itself away (${how}): to a site, or to another content origin`,
      ),
      ...IN_SET_LINKS,
      "a page opens nothing else: not a file that isn't a page, not another path of its origin",
      "no report, content error or blocked navigation names the frame's sealed address (P083)",
    ),
  },
  // A served page on a tab of its own (P099): its CSP's sandbox is the wall for links and forms
  // in new windows, downloads, browser dialogs and its opener; window.open and picture-in-picture
  // have the shell's lock behind it too, so their case fails only with both out.
  "tab-sandbox": { specs: [TAB], fails: all(...TAB_SANDBOX) },
  "window-open": {
    specs: [TAB],
    fails: NOTHING,
    holds: { why: "the CSP's sandbox stops a window first", by: "tab-sandbox,window-open" },
  },
  "tab-sandbox,window-open": {
    specs: [TAB],
    fails: all(...TAB_SANDBOX, "served.domain.tab-window-open"),
  },
  // navigation.navigate() and a tab's links ask the guard's rule before they start (P099): WebKit
  // sends their request though the navigate event cancels it; Chromium and Firefox hold by the
  // event alone. The shell follows a link only where the rule lets it.
  "navigate-ask": {
    specs: [TAB],
    fails: each([], { webkit: ["served.domain.tab-navigation", "served.domain.tab-links"] }),
    holds: {
      why: "on Chromium and Firefox the navigate event cancels what the rule would have",
      by: "navigate-guard",
    },
  },
  // A tab's links followed by the shell, as it read them (P099): without it the browser follows
  // them after content's listeners, and WebKit sends a cancelled one's request.
  "link-rule": {
    specs: [TAB],
    fails: each([], { webkit: ["served.domain.tab-links", "served.domain.tab-navigation"] }),
    holds: {
      why: "on Chromium and Firefox the navigate event cancels a link the browser follows",
      by: "link-rule,navigate-guard",
    },
  },
  "link-rule,navigate-guard": {
    specs: [TAB],
    fails: all("served.domain.tab-navigation", "served.domain.tab-links"),
  },
  // Its devices, location and full screen (P099): the Permissions-Policy header, and the shell's
  // locks behind it (the only wall where the header isn't applied: WebKit, Firefox). WebKit
  // refuses each prompt at once without them (no share sheet on desktop, no authenticator).
  "permissions-policy": {
    specs: [TAB],
    fails: NOTHING,
    holds: {
      why: "the shell's locks deny what the header would",
      by: "permissions-policy,device-locks",
    },
  },
  "device-locks": {
    specs: [TAB],
    fails: each([], {
      webkit: ["served.domain.tab-devices"],
      firefox: ["served.domain.tab-devices", "served.domain.tab-prompts"],
    }),
    holds: {
      why: "Chromium applies the Permissions-Policy header, which denies them first",
      by: "permissions-policy,device-locks",
    },
  },
  "permissions-policy,device-locks": {
    specs: [TAB],
    fails: each(["served.domain.tab-devices"], {
      chromium: ["served.domain.tab-prompts"],
      firefox: ["served.domain.tab-prompts"],
    }),
  },
  // A url-mode app's origin check (P101): WebKit keeps no framed cookie (P025), so only the
  // framed half of the case rides one, on Chromium and Firefox.
  "url-origin": {
    specs: [SERVED],
    fails: each([], {
      chromium: ["served.url.siblings"],
      firefox: ["served.url.siblings"],
    }),
    holds: {
      why: "no probe can see it on WebKit here: it keeps no cookie in a cross-site frame (P025), and the reference serving's labels are cross-site, so no request of another origin rides the app's cookie",
    },
  },
  "service-worker": { specs: [FILES], fails: all("no service worker ever registers") },
  "file-corp": {
    specs: [FILES],
    fails: all(
      "another origin reads none of the files: not another artifact's page, not a page elsewhere",
    ),
  },
  "file-self": {
    specs: [FILES],
    fails: all(
      "a page loads no other version's files, though the browser may open both (P082)",
      "a file outside the set is a 404, and so is every spelling of a way out",
    ),
  },
  // The capability runtime (P085-P091).
  "runtime-declaration": {
    specs: [RUNTIME],
    fails: all(
      "an undeclared capability: null from use, refused when sent anyway, its handler never asked",
    ),
  },
  // The pushed-result probe (P094) stands on the level check too: both its reads are refused for it.
  "runtime-level": {
    specs: [RUNTIME],
    fails: all(
      "a method above the viewer's level: forbidden, its handler never asked",
      PUSHED_READ,
    ),
  },
  // A page's data names, held with a viewer and without one (P094).
  "runtime-data-names": {
    specs: [RUNTIME],
    fails: all(
      "a resource outside the page's data names: refused with a viewer and without one, its handler never asked",
    ),
  },
  // A result the host pushed answers a read only past the read's gates (P094).
  "live-held-read": {
    specs: [RUNTIME],
    fails: all(PUSHED_READ),
  },
  "db-private": {
    specs: [RUNTIME],
    fails: all(
      "a person's own data is theirs: another person's is refused, never reaching the service",
    ),
  },
  "comments-result": {
    specs: [RUNTIME],
    fails: all("comments are write-only: the composer opens from a click, content hears only that"),
  },
  // The focus guard (P109): a page's focus() keeps the person's keys, and is never stopped.
  "focus-guard": {
    specs: [RUNTIME],
    // A page that takes focus back on its blur gets nothing on Chromium and WebKit, guard or not:
    // they don't let it take focus back from its own blur (measured).
    fails: {
      chromium: [TAKE],
      webkit: [TAKE],
      firefox: [TAKE, BLUR_TAKE, FIELD_TAKE],
    },
  },
  // What the guard does after a take-back (P109, GK-1): the watch, the look at every animation
  // frame, focus left on nothing taken back. Only Firefox lands a fought take-back on nothing.
  "focus-guard-watch": {
    specs: [RUNTIME],
    fails: { chromium: [], webkit: [], firefox: [BLUR_TAKE, FIELD_TAKE] },
    holds: {
      why: "no probe can see it on Chromium and WebKit: they blur the host's window on every move into a frame and a take-back lands, and a page can't take focus back from its own blur there (measured)",
    },
  },
  // comments.open needs the person in the calling frame (P109): without it, any gesture on the
  // host's page (typing in its composer) opens it.
  "comments-in-frame": {
    specs: [RUNTIME],
    fails: all(
      "comments.open while the person types in the host's composer reaches no handler, by the page's own call or the shell's; from a press in the frame it does",
    ),
  },
  // A cancel only while the host asked for a pick or for text (P112).
  "cancel-any-mode": {
    specs: [ANNOTATE],
    fails: all(
      "Escape while selecting text is cancelled, and stays the page's key; with no mode on, a page's own cancel isn't heard (P112)",
      "a hostile page fakes reports: the host takes none it didn't ask for, nothing malformed, and not a flood",
    ),
  },
  // A followed mark's box only for that mark, at most 60 a second (P112).
  "track-checks": {
    specs: [ANNOTATE],
    fails: all(
      "a followed mark's box comes as it moves, for that mark only, at most 60 a second, clamped to the frame, until the host stops (P112)",
    ),
  },
  // A mark's place is a whole number below the most marks (P112).
  "order-check": {
    specs: [ANNOTATE],
    fails: all(
      "every found mark's place in the document comes with its box, offscreen ones too; a place that isn't one is no report (P112)",
    ),
  },
  // Holding a block selects it, and its release's click is the shell's (P112).
  "hold-click": {
    specs: [ANNOTATE],
    fails: all(
      "holding a block 500 ms selects it and its release's click never reaches the page; a tap, a moving finger and a mouse are the page's (P112)",
    ),
  },
  // The host's clearSelection is the shell's own, and tells nothing back (P115).
  "clear-selection": {
    specs: [ANNOTATE],
    fails: all(
      "clearSelection takes the page's selection away and tells nothing back; marks and drafts stay, the next selection is told (P115)",
    ),
  },
  // Who may say how loading went (P124, P125). The rule split per the audit of 2026-10-30: a
  // served display that isn't nested takes no frame status from its frame at all (its door told);
  // a nested page's shell keeps the ordering rule; an opaque frame's rule 1 is proven by
  // test/outcome.test.ts alone (P124-3), with no leak probe of its own.
  // Content's own word taken again: a served non-nested display's frame status is an outcome,
  // whether its own content's (the two P124 outcome cases) or a sibling's (inject, reload, proxy).
  "content-status": {
    specs: [OUTCOME, SIBLINGS_STATUS],
    fails: {
      ...all(
        "a served shell's content that says it is blocked is told nothing and shown nothing (P124)",
        "a served artifact page that says it is blocked as it loads is told nothing and shown nothing (P124)",
        "[sibling-inject]",
        "[sibling-reload]",
        "[proxy]",
      ),
      // The sibling probes skip on WebKit (WEBKIT_REFUSES_SIBLING_WRITE): its own content's word.
      webkit: [
        "a served shell's content that says it is blocked is told nothing and shown nothing (P124)",
        "a served artifact page that says it is blocked as it loads is told nothing and shown nothing (P124)",
      ],
    },
  },
  // P124's first-word rule in place of the door: a sibling that speaks first in a served
  // non-nested display's frame (its own, or the sandbox proxy's) is taken.
  "door-status": {
    specs: [SIBLINGS_STATUS],
    fails: { ...all("[sibling-inject]", "[sibling-reload]", "[proxy]"), webkit: [] },
    holds: { why: WEBKIT_REFUSES_SIBLING_WRITE },
  },
  // A served non-nested display's silence read as `framing` again: a sibling that wipes it.
  "door-silence": {
    specs: [SIBLINGS_STATUS],
    fails: { ...all("[sibling-wipe]"), webkit: [] },
    holds: { why: WEBKIT_REFUSES_SIBLING_WRITE },
  },
  // The door not opaque, heard from the location's origin (displays still work): a sibling reads
  // the live door and rewrites it into Porthole's own status page, which speaks for the display.
  "door-opaque": {
    specs: [SIBLINGS_STATUS],
    fails: all("[door-reach]"),
  },
  // The ordering rule taken out for a nested page's shell: a page's word after its hello taken.
  "frame-status-order": {
    specs: [OUTCOME],
    fails: all(
      "a nested page that says it is blocked, through its shell or past it, is told nothing and shown nothing (P124)",
    ),
  },
  "shell-namespace": {
    specs: [NESTED],
    fails: all(
      "the shell's words are the shell's alone: a page that says them, to its parent or to the host's window, moves nothing",
    ),
  },
  // A nested page's shell on a label of its own (P114, porthole#56): on its scope's, a same-scope
  // inline widget or artifact reads the shell's document, and in it the page's sealed address.
  // Alone, the host's mount refuses the scope's label (P121), and the shell wouldn't run there: run
  // with both taken out too, as a content Worker of a host's own and an old host would be.
  "shell-label,nested-host-label,nested-shell-origin": {
    specs: [NESTED_SIBLINGS],
    fails: all("[nested-siblings]", "[nested-label]"),
  },
  // The host's mount refuses a nested page located anywhere but a shell's own label (P121).
  "nested-host-label": {
    specs: [NESTED_SIBLINGS],
    fails: all("[nested-label]"),
  },
  // The shell runs on a shell's own label alone (P121): the wall behind the host's mount, for a
  // host whose platform isn't Porthole's.
  "nested-shell-origin": {
    specs: [NESTED_SIBLINGS],
    fails: NOTHING,
    holds: {
      why: "the host's mount refuses a shell located on any other label first, and /server serves none there",
      by: "shell-label,nested-host-label,nested-shell-origin",
    },
  },
  // Every file below a nested page's sealed prefix is sandboxed (P111, after its review).
  "file-sandbox": {
    specs: [NESTED],
    fails: all(
      "a page's SVG or XML file opened on a tab of its own is an opaque origin, and its script touches nothing of the shell's (P111, after its review)",
    ),
  },
  // A nested page's frame that takes focus back in a fight over a text field is judged as any
  // frame is, its shell not asked (P120): let be, the page keeps the keyboard. Only Firefox lets a
  // page take focus back on its own blur.
  "nested-fight": {
    specs: [NESTED],
    fails: { chromium: [], webkit: [], firefox: [NESTED_FIGHT] },
    holds: {
      why: "no probe can see it on Chromium and WebKit: a page can't take focus back from its own blur there, so no fight has a frame take focus again (measured)",
    },
  },
  // A stalled shell's activation is uncertain (P111, after its review).
  "shell-stall": {
    specs: [NESTED],
    fails: all(STALL_RULE),
  },
  // A nested page's gesture needs a quiet host (P111): a page that takes the keyboard within a
  // second of the person's press in it keeps it though they went back to the host's composer.
  "shell-host-input": {
    specs: [NESTED],
    fails: all(
      "a page's focus() just after the person pressed it and went back to the host's composer is taken back",
    ),
  },
  // Where the host's page sees the pointer, an activation that turned on as the person typed, the
  // pointer elsewhere, is their key landing in the page, judged as it turned on (P120).
  // No press comes within 250 ms of the person's key on the host's page (P122): an activation that
  // turns on then is their key landing in the page, where the pointer is never seen too.
  "key-press": {
    specs: ["leak/served/nested-key.spec.ts"],
    fails: all(
      "an activation that turned on within 250 ms of the person's key on the host's page is no gesture, where the pointer is never seen too (P122)",
    ),
  },
  "pointer-rule": {
    specs: [NESTED],
    fails: all(
      "an activation that came as the person typed, the pointer elsewhere, is no gesture a second on either (P120, after its review)",
    ),
  },
  "comment-draft": {
    specs: [RUNTIME],
    fails: all(
      "a comment's draft is the host's to check: past the limit, holding what a person can't see, or not text, it opens no composer (P108)",
    ),
  },
  // Two walls stand behind a script from /_blob/: the CSP and the type it is served as. Each
  // control alone takes one out; the CSP's probe fails only with both out.
  "blob-script": {
    specs: [RUNTIME],
    fails: NOTHING,
    holds: {
      why: "an untrusted script asset is served as a download",
      by: "blob-script,blob-trusted",
    },
  },
  "blob-trusted": { specs: [RUNTIME], fails: all(TRUSTED_CODE) },
  "blob-script,blob-trusted": {
    specs: [RUNTIME],
    fails: all(
      TRUSTED_CODE,
      "scripts load from /_blob/ only where uploads are the admins' (a tab, its session)",
    ),
  },
  "blob-inert": {
    specs: [RUNTIME],
    fails: all("an asset opened on its own runs nothing, on a tab with the artifact's session"),
  },
};

// ---------------------------------------------------------------------------------------------
// Judging a control's run.

/** What the runner saw of the child: `spawnSync`'s result, as far as the judge needs it. */
export interface Run {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: Error | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * How a test ended: `failed` is its verdict failing (an `expect` marked `VERDICT`), the only
 * failure a control may count; `unmarked` an `expect` of its setup or positive control; the rest
 * are runs that prove nothing (skipped, never run, timed out, interrupted, an error that isn't an
 * assertion: a browser that didn't start, a harness that threw).
 */
export type Outcome =
  | "passed"
  | "failed"
  | "unmarked"
  | "skipped"
  | "not run"
  | "timed out"
  | "interrupted"
  | "errored";

export interface TestResult {
  /** Its whole title, with its describe blocks. */
  readonly title: string;
  /** Its own title, which the registry names. */
  readonly name: string;
  readonly project: string;
  readonly outcome: Outcome;
  /** What the test declares (`test.fail`: failed; `test.skip`: skipped). */
  readonly expected: "passed" | "failed" | "skipped";
  /** The first line of its error, where it has one. */
  readonly error: string;
}

export interface Verdict {
  readonly ok: boolean;
  /** One line per engine: what failed. */
  readonly summary: string;
  readonly problems: readonly string[];
}

// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

interface JsonError {
  readonly message?: string;
}
interface JsonResult {
  readonly status?: string;
  readonly error?: JsonError;
  readonly errors?: readonly JsonError[];
}
interface JsonTest {
  readonly projectName: string;
  readonly status: string;
  readonly expectedStatus?: string;
  readonly results?: readonly JsonResult[];
}
interface JsonSuite {
  readonly title?: string;
  readonly suites?: readonly JsonSuite[];
  readonly specs?: readonly { readonly title: string; readonly tests: readonly JsonTest[] }[];
}

function firstLine(error: JsonError | undefined): string {
  return (error?.message ?? "").replace(ANSI, "").trim().split("\n")[0] ?? "";
}

/**
 * An error an `expect` raised: Playwright's message has the matcher's call on a line of its own
 * (after the assertion's own message, where it has one); the source it quotes is indented.
 */
function isAssertion(error: JsonError): boolean {
  return /^(Error: )?expect(\.soft|\.poll)?\(/m.test((error.message ?? "").replace(ANSI, ""));
}

/** An error of a probe's verdict: its first line is the deciding `expect`'s message. */
function isVerdict(error: JsonError): boolean {
  return new RegExp(`^(Error: )?${VERDICT}`).test(firstLine(error));
}

function outcomeOf(test: JsonTest): {
  outcome: Outcome;
  expected: TestResult["expected"];
  error: string;
} {
  const expected =
    test.expectedStatus === "skipped"
      ? "skipped"
      : test.expectedStatus === "failed"
        ? "failed"
        : "passed";
  const last = test.results?.at(-1);
  if (last === undefined) {
    return { outcome: "not run", expected, error: "" };
  }
  const errors =
    last.errors !== undefined && last.errors.length > 0
      ? last.errors
      : last.error === undefined
        ? []
        : [last.error];
  const error = firstLine(errors[0]);
  if (expected === "skipped") {
    return { outcome: "skipped", expected, error };
  }
  switch (last.status) {
    case "passed":
      return { outcome: "passed", expected, error };
    case "skipped":
      return { outcome: "skipped", expected, error };
    case "timedOut":
      return { outcome: "timed out", expected, error };
    case "interrupted":
      return { outcome: "interrupted", expected, error };
    case "failed": {
      const [first] = errors;
      const outcome: Outcome =
        first === undefined || !errors.every((one) => isAssertion(one))
          ? "errored"
          : isVerdict(first)
            ? "failed"
            : "unmarked";
      return { outcome, expected, error };
    }
    default:
      return { outcome: "not run", expected, error };
  }
}

/** The run's tests, flattened from Playwright's JSON report. */
export function resultsOf(report: { readonly suites?: readonly JsonSuite[] }): TestResult[] {
  const out: TestResult[] = [];
  const walk = (suite: JsonSuite, titles: readonly string[]): void => {
    const here =
      suite.title === undefined || suite.title.endsWith(".ts") ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        out.push({
          title: [...here, spec.title].join(" › "),
          name: spec.title,
          project: test.projectName,
          ...outcomeOf(test),
        });
      }
    }
    for (const child of suite.suites ?? []) {
      walk(child, here);
    }
  };
  for (const suite of report.suites ?? []) {
    walk(suite, []);
  }
  return out;
}

const said = (test: TestResult): string =>
  test.error === "" ? test.outcome : `${test.outcome}: ${test.error.slice(0, 200)}`;

/**
 * A control's run, judged: every engine asked ran its specs, every test the control is for failed
 * by its own assertion there, and nothing else failed. A negative control's run exits 1 (its
 * probes fail), so the exit status is checked against what the control expects, never against 0.
 */
export function judge(control: Control, engines: readonly Engine[], run: Run): Verdict {
  const problems: string[] = [];
  const fail = (summary: string): Verdict => ({ ok: false, summary, problems });
  if (run.error !== undefined) {
    problems.push(`the run didn't start: ${run.error.message}`);
    return fail("no run");
  }
  if (run.signal !== null) {
    problems.push(`the run was killed (${run.signal})`);
  }
  let report: { suites?: readonly JsonSuite[]; errors?: readonly JsonError[] };
  try {
    report = JSON.parse(run.stdout) as typeof report;
  } catch {
    problems.push(`the run gave no report: ${run.stderr.slice(-2000)}`);
    return fail("no report");
  }
  for (const error of report.errors ?? []) {
    problems.push(`the run reported an error: ${firstLine(error)}`);
  }
  const results = resultsOf(report);
  const counts: string[] = [];
  let expectsFailure = false;
  for (const engine of engines) {
    const mine = results.filter((one) => one.project === engine);
    if (mine.length === 0) {
      problems.push(`[${engine}] no test ran: the engine isn't in the report`);
      counts.push(`${engine} not run`);
      continue;
    }
    const targets = control.fails[engine];
    expectsFailure ||= targets.length > 0;
    const matched = new Set<TestResult>();
    for (const expected of targets) {
      // A probe in more than one spec (the leak suite on two host pages) is a test in each.
      const found = mine.filter((one) => names(expected, one.name));
      if (found.length === 0) {
        problems.push(`[${engine}] no test "${expected}"`);
      }
      for (const probe of found) {
        matched.add(probe);
        const which = found.length > 1 ? ` (${probe.title})` : "";
        if (probe.outcome === "passed") {
          problems.push(`[${engine}] "${expected}"${which} passed: the control has gone blind`);
        } else if (probe.outcome !== "failed") {
          problems.push(
            `[${engine}] "${expected}"${which} didn't fail by its verdict: ${said(probe)}`,
          );
        }
      }
    }
    const why = (one: TestResult): string =>
      one.error === "" ? "" : `: ${one.error.slice(0, 200)}`;
    const failure = (outcome: Outcome): boolean =>
      outcome === "failed" ||
      outcome === "unmarked" ||
      outcome === "errored" ||
      outcome === "timed out";
    for (const one of mine) {
      if (matched.has(one)) {
        continue;
      }
      if (control.others === "fail") {
        if (one.outcome !== "failed" && one.outcome !== "unmarked" && one.outcome !== "timed out") {
          problems.push(
            `[${engine}] "${one.title}" ${one.outcome}, though every test should fail${why(one)}`,
          );
        }
      } else if (one.expected === "failed") {
        // `test.fail`: its failure is the run as it always is; its passing is news (after the review).
        if (!failure(one.outcome) && one.outcome !== "skipped") {
          problems.push(
            `[${engine}] "${one.title}" ${one.outcome}, though it is declared to fail (test.fail)`,
          );
        }
      } else if (one.outcome !== "passed" && one.outcome !== "skipped") {
        const outcome = one.outcome === "unmarked" ? "failed" : one.outcome;
        problems.push(`[${engine}] "${one.title}" ${outcome} too${why(one)}`);
      }
    }
    const failed = mine.filter((one) => one.outcome === "failed").length;
    const skipped = mine.filter((one) => one.outcome === "skipped").length;
    counts.push(
      `${engine} ${failed} of ${mine.length} failed${skipped > 0 ? ` (${skipped} skipped)` : ""}`,
    );
  }
  for (const project of new Set(results.map((one) => one.project))) {
    if (!(engines as readonly string[]).includes(project)) {
      problems.push(`[${project}] ran, though it wasn't asked for`);
    }
  }
  const wanted = expectsFailure ? 1 : 0;
  if (problems.length === 0 && run.status !== wanted) {
    problems.push(`the run exited ${String(run.status)}, not ${wanted}`);
  }
  return { ok: problems.length === 0, summary: counts.join(", "), problems };
}

// ---------------------------------------------------------------------------------------------
// CI's shards: a job runs one shard of the registry on one engine, and a last job checks that
// every control ran and held on every engine (a whole engine's controls outlast a job's timeout).

/**
 * Each control's run, measured (seconds, the three engines at once on the shared box, 2026-10-20):
 * a weight for splitting the registry into shards, nothing more. A control not here weighs the
 * median.
 */
const MEASURED: Readonly<Record<string, number>> = {
  "connect-src": 90,
  webrtc: 86,
  "frame-guard": 87,
  "attach-shadow": 85,
  "sync-guard": 85,
  "frame-guard,sync-guard": 91,
  "attach-shadow,sync-guard": 87,
  "declarative-shadow": 87,
  "parser-entry-points": 98,
  "embedder-csp": 116,
  "embedder-self": 88,
  sandbox: 103,
  "base-uri": 90,
  self: 90,
  "style-split": 90,
  "draft-inert": 87,
  "document-theme": 88,
  "confirm-gate": 97,
  "shell-gesture": 89,
  "host-gesture": 93,
  "model-context-show": 88,
  "link-scheme": 88,
  clipboard: 89,
  "report-unbounded": 169,
  nonce: 670,
  "annotation-checks": 18,
  authorize: 19,
  "url-permissions": 7,
  "navigate-guard": 56,
  "tab-sandbox": 38,
  "window-open": 37,
  "tab-sandbox,window-open": 43,
  "navigate-ask": 44,
  "link-rule": 37,
  "link-rule,navigate-guard": 32,
  "permissions-policy": 38,
  "device-locks": 37,
  "permissions-policy,device-locks": 38,
  "url-origin": 19,
  "service-worker": 20,
  "file-corp": 22,
  "file-self": 22,
  "runtime-declaration": 20,
  "runtime-level": 20,
  "runtime-data-names": 19,
  "live-held-read": 19,
  "db-private": 20,
  "comments-result": 19,
  "blob-script": 17,
  "blob-trusted": 20,
  "blob-script,blob-trusted": 21,
  "blob-inert": 23,
  "annotation-activated": 20,
  "annotation-activated-count": 20,
  "marker-trusted": 20,
  "marker-click": 20,
  "annotation-rect-clamp": 20,
  // P105's (2026-10-20).
  "marker-prevent": 69,
  "marker-originals": 73,
  "follow-throttle": 70,
  "selection-follow": 70,
  "follow-count": 70,
  "annotation-activated-gesture": 69,
  "marker-tap": 83,
  "marker-place": 83,
};

/**
 * The controls of shard `index` (1 to `count`): the registry split by weight, heaviest first, each
 * to the lightest shard so far (ties to the lower shard), in the registry's order. The same
 * registry always splits the same way, and every control is in exactly one shard.
 */
export function shard(index: number, count: number): string[] {
  const registered = Object.keys(CONTROLS);
  const weights = registered.map((name) => MEASURED[name]).filter((one) => one !== undefined);
  const median = weights.toSorted((a, b) => a - b)[Math.floor(weights.length / 2)] ?? 1;
  const weight = (name: string): number => MEASURED[name] ?? median;
  const totals = Array.from({ length: count }, () => 0);
  const of = new Map<string, number>();
  for (const name of registered.toSorted((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const lightest = totals.indexOf(Math.min(...totals));
    of.set(name, lightest);
    totals[lightest] = (totals[lightest] ?? 0) + weight(name);
  }
  return registered.filter((name) => of.get(name) === index - 1);
}

/** What a run of controls left for the summary: each control's verdict, on the engines it ran. */
export interface Verdicts {
  readonly engines: readonly string[];
  readonly shard: string | null;
  readonly controls: Readonly<
    Record<string, { readonly ok: boolean; readonly problems: readonly string[] }>
  >;
}

/**
 * Every shard's verdicts, put together: each control of the registry must have run and held on
 * every engine. A control no shard ran on an engine (a job cancelled, a shard that lost one) is a
 * problem as much as one that failed.
 */
export function summarize(runs: readonly Verdicts[], engines: readonly Engine[]): string[] {
  const problems: string[] = [];
  for (const engine of engines) {
    for (const name of Object.keys(CONTROLS)) {
      const seen = runs.filter(
        (run) => run.engines.includes(engine) && run.controls[name] !== undefined,
      );
      if (seen.length === 0) {
        problems.push(`[${engine}] ${name} never ran`);
      } else if (seen.some((run) => run.controls[name]?.ok !== true)) {
        problems.push(`[${engine}] ${name} failed`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// DESIGN.md's table of the controls.

const ENGINE_NAMES: Readonly<Record<Engine, string>> = {
  chromium: "Chromium",
  webkit: "WebKit",
  firefox: "Firefox",
};

/**
 * Each control as a row of DESIGN.md's table (checked by `test/controls.test.ts`): what it fails on
 * every engine, then what only some engines fail.
 */
export function controlsTable(): string {
  const list = (tests: readonly string[]): string =>
    tests.length === 0 ? "nothing" : tests.map((one) => `\`${one}\``).join(", ");
  const rows = Object.entries(CONTROLS).map(([name, control]) => {
    const specs = control.specs.map((spec) => `\`${spec.replace(/^leak\//, "")}\``).join(", ");
    const common = control.fails.chromium.filter((one) =>
      ENGINES.every((engine) => control.fails[engine].includes(one)),
    );
    const own = new Map<string, Engine[]>();
    for (const engine of ENGINES) {
      const extra = control.fails[engine].filter((one) => !common.includes(one));
      if (extra.length > 0) {
        const key = list(extra);
        own.set(key, [...(own.get(key) ?? []), engine]);
      }
    }
    const some = [...own]
      .map(([tests, engines]) => `${engines.map((one) => ENGINE_NAMES[one]).join(", ")}: ${tests}`)
      .join("; ");
    const every = control.others === "fail" ? ", and every other test" : "";
    const holds =
      control.holds === undefined
        ? "—"
        : `${control.holds.why}${control.holds.by === undefined ? "" : ` (\`${control.holds.by}\`)`}`;
    return `| \`${name}\` | ${specs} | ${list(common)}${every} | ${some === "" ? "—" : some} | ${holds} |`;
  });
  return [
    "| Control | Run with | Fails on every engine | Fails only on | Where it fails nothing, why |",
    "|---------|----------|-----------------------|---------------|-----------------------------|",
    ...rows,
  ].join("\n");
}
