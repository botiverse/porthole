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
  config: **inline widget**, **artifact** (a standalone page), **MCP Apps** (the
  standard protocol), and **URL** (a running app framed by URL, such as a dev
  server's preview).

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

4. **Embed with near-zero config across the modes.**
   - *Success:* a host mounts an inline widget, an artifact page, an MCP Apps
     view and a URL frame each in a few lines using only a preset, theme tokens
     and callbacks; the framework-agnostic core and the React binding both do
     this; no host-specific code lives in the core.

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
- **A component vocabulary inside the sandbox.** Content is plain HTML and SVG,
  taught by the generated manual; a consistent look comes from the injected theme
  variables and, at most, plain base CSS for native elements, never from tags and
  props an agent must learn (P015). Nor is Porthole a design-system library.
- **A new widget-side protocol.** The contract is MCP Apps; we do not define an
  alternative (PRINCIPLE 2).
- **A shell or egress control for URL mode.** A URL frame is someone else's
  running app: Porthole gives it isolation and access auth, nothing more (P020).
- **Operating infrastructure.** The serving part (`/server`) is a request handler a
  host mounts in its own backend; Porthole runs no service, domain or certificate
  of its own.
- **Being an agent framework or an MCP server.** Porthole is host-side rendering
  and isolation. It does not run models, implement an MCP server, or decide
  product policy (PRINCIPLE 8).

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

- the framework-agnostic web core and the React binding (with its default,
  replaceable confirmation dialog) exist, with opaque-origin isolation, egress
  hardening, the shell runtime, streaming render, auto-sizing, theming, and the
  host-function bridge;
- the served modes exist: domain mode (a stable origin per storage scope, CSP in
  headers, ticket → cookie for private content) with its `/server` request
  handler, the artifact page on it, and URL mode (frame, isolation and access
  auth only);
- the presets exist (inline widget, artifact page, MCP Apps view, URL), each
  generating its CSP and frame policy, and all but URL its shell and manual, from
  one config;
- the MCP Apps adapter runs the official ext-apps examples unmodified;
- the leak/conformance suite passes on Chromium and WebKit, then Firefox, and is
  runnable by any host; and
- the first host has migrated onto it (dogfooding), every one of its features
  that shows agent-made or foreign HTML (widgets, shown HTML files, the dev-server
  preview) going through Porthole, with its own code reduced to configuration
  plus callbacks.

Native hosts (WKWebView, maybe Android) are phase 2.
