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

Phase 1 is in design. The repository holds docs only; there is no code to build
yet. The tooling below is the agreed target (see DESIGN.md), written down now so
it is not re-litigated later.

## Setup (target)

- Node ≥ 24 (TypeScript runs directly via type stripping — erasable syntax only:
  no enums, no parameter properties, no namespaces; relative imports carry `.ts`).
- pnpm workspace.
- The web core is framework-agnostic TypeScript; the React binding is a thin,
  separate package.

## Commands (target)

```bash
pnpm check            # typecheck + lint + format check + unit tests (run before every commit)
pnpm test             # unit tests (vitest or node:test)
pnpm test:leak        # the Playwright conformance/leak suite (Chromium, WebKit, Firefox)
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
   hardening item without a passing test does not exist (PRINCIPLE 5).
3. If you changed the config schema, regenerate and re-read the example CSP,
   shell and guide, and confirm all three still agree.
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
