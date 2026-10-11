# Porthole — agent guide

Porthole is a host-side library for safely showing agent-made HTML inside an app
(inline widgets, standalone artifacts, and the standard MCP Apps protocol). It is
a security-sensitive isolation layer: read the design before changing anything
structural, and never weaken a security default quietly.

Read these first:

| Doc | What it tells you |
| --- | --- |
| [docs/PRINCIPLES.md](docs/PRINCIPLES.md) | The rules decisions are made by. |
| [docs/OBJECTIVES.md](docs/OBJECTIVES.md) | What Porthole is for; success criteria; non-goals. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, contracts, flows, trust boundaries, extension points. Stays stable while APIs change. |
| [docs/DESIGN.md](docs/DESIGN.md) | The concrete phase-1 design. |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why things are the way they are, and when to revisit. **Add an entry (P0xx) when you make or change a decision.** |

## Status

Phase 1 is being built, milestone by milestone (DESIGN.md § Milestones). M1–M3
are in: the config, compiler and presets; the isolation core (`createHost`, the web
platform, the shell runtime, the shell adapter, the gated bridge); streaming,
sizing and theming; the leak suite with its oracles and negative controls. Unbuilt
functions throw `NotBuiltYet`.

## Setup

- Node ≥ 24 (TypeScript runs directly via type stripping — erasable syntax only:
  no enums, no parameter properties, no namespaces; relative imports carry `.ts`).
- pnpm 11 workspace; one package, `packages/porthole` (`@botiverse/porthole`,
  with `/react`, `/mcp`, `/conformance`, `/server` as subpath exports, P013).
- The core is framework-agnostic TypeScript; the React binding is a thin subpath.

## Commands

```bash
pnpm check            # typecheck + lint + format check + unit tests (run before every commit)
pnpm test             # unit tests (vitest; packages/porthole/test)
pnpm test:leak        # the Playwright conformance/leak suite (Chromium + WebKit; Firefox from M5)
PORTHOLE_LEAK_ENGINES=chromium pnpm test:leak   # a subset, where an engine can't run
PORTHOLE_LEAK_WEAKEN=sync-guard pnpm test:leak  # a negative control: its probes must fail (P032)
pnpm --filter @botiverse/porthole build         # dist/ (JS + .d.ts) for packing
pnpm exec oxfmt <file>                          # format (never prettier)
```

WebKit needs system libraries a shared Linux box may lack (no sudo there): run the
WebKit half of the leak suite on a machine that has them (`playwright install
--with-deps webkit`). Scratch files go under `.dev/scratch/` (gitignored).

## Layout

```
packages/porthole/src/   config/ compile/ shell/ guide/ theme/ presets/   the compiler side
                         protocol/ bridge/ transport/ platform/ isolation/ host/   the seams
                         react/ mcp/ conformance/ server/                 the subpath entries
packages/porthole/test/  unit tests; agreement.test.ts is the config ↔ CSP ↔ shell ↔ manual check
packages/porthole/leak/  the leak suite run against Porthole's reference host
```

## Conventions

- **Validate at trust boundaries, trust types inside.** Every message crossing
  the frame boundary (both directions) is validated before use; malformed
  messages are dropped, not coerced.
- **One config is the source of truth.** The CSP, the iframe sandbox/`allow`
  attributes, the in-frame shell, the host-function bridge, and the agent manual
  are all generated from the same config. Never hand-edit one so it disagrees
  with another; change the generator.
- **The external contract is MCP Apps.** Do not invent a widget-side protocol.
  Gaps go through the spec's extension points (experimental capabilities,
  own-prefixed methods) and, where they are general, upstream to the spec.
- **Lint with the standard toolchain:** oxlint (type-aware) and oxfmt, matching
  the wider workspace style. No `console` in library code; no `any`.

## Verify your change (required before saying "done")

1. Run `pnpm check`. It must pass.
2. If you touched isolation, egress, the shell, the CSP generator, or any
   host-function gate, run `pnpm test:leak` on every engine it supports. A
   hardening item without a passing test does not exist (PRINCIPLE 5). A new
   defense gets a negative control in `leak/server.ts` and DESIGN.md's table says
   which probes it fails (P032).
3. If you changed the config schema, regenerate and re-read the example CSP,
   shell and guide, and confirm all three still agree (`test/agreement.test.ts`
   must pass, and must still cover what you added).
4. If behavior changed, add or extend a test at the lowest layer that can
   observe it. For a leak, first write the test that fails, then fix it.
5. If you touched the MCP Apps adapter, run the official ext-apps example servers
   against it and confirm they render and interact unmodified (OBJECTIVE 3).

## Never weaken a security default silently

Isolation and egress defaults (origin isolation on, egress closed, host functions
off until declared, gates on by default) may be loosened only through a decision
entry that names the threat it re-opens and ships the test that bounds it
(PRINCIPLE 1). A pull request that widens an allowlist, drops a sandbox flag,
removes a gate, or relaxes the CSP without such an entry is a defect, even if a
test still passes.

## Give upstreams feedback

Porthole depends on a public standard (MCP Apps) and its SDK. When they lack
something or a spec clause is ambiguous, open an issue upstream with evidence and
a suggestion, and link it from any workaround here.
