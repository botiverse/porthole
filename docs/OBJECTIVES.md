# Objectives

## What Porthole is for

Any app that wants the "show content made by an agent" ability — like the inline
visuals and standalone pages in ChatGPT and the Claude app — should be able to
embed Porthole and get a working, safe display out of the box, plus the manual
that teaches the agent to write for it.

The library has two layers:

- a **framework layer** of mechanisms (isolation, egress hardening, the in-frame
  shell, streaming, sizing, theming, the host-function bridge, the guide
  generator); and
- a **preset policy layer** of ready-made bundles a host adopts with near-zero
  config: **inline widget**, **artifact** (a standalone page), and **MCP Apps**
  (the standard protocol).

The subject, stated generally, is **HTML drawn by an agent that may optionally
interact with the agent** — and that interaction is just one host function among
several. "Out of the box" means: a host picks a preset, passes theme tokens and
callbacks, and receives a safe display plus a generated agent manual.

## Objectives and success criteria

1. **Show untrusted agent HTML without putting the host at risk.**
   - *Success:* the conformance/leak suite passes on Chromium, WebKit and
     Firefox — every egress and escape probe attempts its channel and observes
     nothing; the content cannot reach the host origin, its storage, its DOM, or
     its credentials.

2. **One config generates the sandbox, the shell, and the manual, in agreement.**
   - *Success:* for every preset, a test derives the CSP, the shell's wired host
     functions, and the generated guide from the same config and asserts they
     match — the guide names only variables the shell injects and only
     capabilities the CSP and bridge allow; changing the config changes all
     three together.

3. **Speak the MCP Apps standard, proven against the reference implementation.**
   - *Success:* the MCP Apps preset renders and interacts with the official
     ext-apps example servers **unmodified** (initialize handshake, tool input
     and result, size and theme changes, open-link and message), driven in the
     leak suite.

4. **Embed with near-zero config across the three modes.**
   - *Success:* a host mounts an inline widget, an artifact page, and an MCP Apps
     view each in a few lines using only a preset name, theme tokens and
     callbacks; the framework-agnostic core and the React binding both do this;
     no host-specific code lives in the core.

5. **Ship the agent manual as a first-class output.**
   - *Success:* each preset produces an agent-facing guide and tool description
     from its config; a real agent that reads the guide produces content that
     renders within the sandbox and reads correctly at the target widths in light
     and dark, checked by rendering the guide's own examples in the leak suite.

## Non-goals

- **Host-drawn DSL rendering.** Rendering a JSON/JSX/remote-DOM UI description
  with the host's own native components (A2UI, json-render, remote-dom, JSX
  preview) is a separate concern and a different project. Porthole is the HTML
  sandbox only.
- **A new widget-side protocol.** The contract is MCP Apps; we do not define an
  alternative (PRINCIPLE 2).
- **Hosting or serving the content in phase 1.** Phase 1 isolates HTML the host
  already has (injected into an opaque-origin frame). Serving content from a
  dedicated domain (the artifact/domain mode server) is designed in phase 1 but
  built in phase 2.
- **URL mode / live web preview.** Embedding a running app by URL (origin
  isolation and access auth only, no shell, no egress control) is out of scope
  for now; revisit later if a host needs it.
- **Being an agent framework or an MCP server.** Porthole is host-side rendering
  and isolation. It does not run models, implement an MCP server, or decide
  product policy (PRINCIPLE 8).
- **A component/design-system library.** Preset components are a small, themed
  set for the sandbox, not a general UI kit.

## Who the users are

- **Host app developers** who want to show agent-made HTML in a chat or canvas UI
  and do not want to build or audit an isolation layer themselves. They are the
  primary users: they embed the library and pick a preset.
- **Agents (and the people prompting them)** who write the HTML. They are served
  indirectly: the generated manual is written for them, and the sandbox is the
  environment their code runs in.
- **MCP App authors** who build standard MCP Apps and want them to render in any
  Porthole-based host unmodified.

The first adopter is a normal user of the public API, with no privileged path
(PRINCIPLE 9).

## What "done" means for phase 1

Phase 1 is done when:

- the framework-agnostic web core and the React binding exist, with
  opaque-origin isolation, egress hardening, the shell runtime, streaming render,
  auto-sizing, theming, and the host-function bridge;
- the three presets exist (inline widget, MCP Apps view, and the artifact page
  mode designed — built where it needs no server, server parts deferred to
  phase 2), each generating its CSP, shell, preset components, and manual from
  one config;
- the MCP Apps adapter runs the official ext-apps examples unmodified;
- the leak/conformance suite passes on Chromium, WebKit and Firefox, and is
  runnable by any host; and
- the first host has migrated onto it (dogfooding), with its own widget code
  reduced to configuration plus callbacks.

The domain/served-page server, native hosts, and URL mode are phase 2.
