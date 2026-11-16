# Principles and objectives

These are the rules we use to make decisions quickly. When a choice is unclear,
pick the option that best satisfies these, write it down in
[DECISIONS.md](DECISIONS.md), and move on. Principles change only through a
decision entry.

Each principle gives its reason and what it rules out.

## 1. Security defaults cannot be weakened silently

Isolation is on, egress is closed, host functions are off until declared, and
their gates are on — by default. Any change that loosens a default (widens an
allowlist, drops a sandbox flag, relaxes the CSP, removes a gate) happens only
through a decision entry that names the threat it re-opens and ships the test
that bounds the new risk.

- **Why.** The whole point of the library is that a host can hand it untrusted
  HTML without reasoning about browser internals. A quiet loosening moves risk
  onto hosts who never agreed to it.
- **Rules out.** Convenience flags that trade safety for a smaller config;
  "temporary" allowlist entries without an owner; a default that is safe only if
  the host remembers to also set something.

## 2. The external contract is the standard; we do not invent a widget protocol

What the agent-written HTML speaks to its host is **MCP Apps**
(`io.modelcontextprotocol/ui`). Gaps are filled through the spec's own extension
points (experimental capabilities, own-prefixed methods), and anything general is
taken upstream to the spec, not kept as a private dialect.

- **Why.** The value of standard agent-UI is that one widget runs in many hosts
  and one host renders many widgets. A bespoke protocol forfeits that and makes
  every author integrate with us specifically.
- **Rules out.** A new wire format for widgets; forking the protocol to ship a
  feature faster; host-specific globals the widget must detect.

## 3. One config is the single source for the sandbox, the shell, and the manual

From one config Porthole derives the CSP, the iframe sandbox and `allow`
attributes, the in-frame shell, the host-function bridge, **and** the
agent-facing guide and tool description. They are generated together, never
edited apart.

- **Why.** These four artifacts must agree to be safe and usable: a manual that
  promises a capability the CSP blocks wastes the agent's turns; a CSP that
  allows more than the manual teaches is unaudited surface. Drift between them is
  the most common defect in hand-built sandboxes.
- **Rules out.** A guide maintained by hand; a CSP string literal that no test
  ties back to the capability list; teaching a variable or function the shell
  does not inject.

## 4. Everything the HTML can do beyond drawing is a declared host function

Drawing pixels is free; every other power — send a prompt to the agent, open a
link, read or write state, call a tool, read data, report an error — is a
**host function (capability)** named in the config. Each declares its gate (needs
a user gesture, needs a person's confirmation, is rate-limited), its egress
needs, and its guide entry. Talking to the agent is just one host function among
these.

- **Why.** This is the core abstraction: "agent-drawn HTML + host functions." It
  gives one list that drives the bridge, the CSP and the manual at once (see
  PRINCIPLE 3), and it makes the question "what can this content do?" answerable
  by reading the config.
- **Rules out.** Ambient powers the HTML gets without the host opting in; a
  capability wired into the bridge but absent from the CSP or the manual; a
  gate decided ad hoc per call site instead of declared once.

## 5. Every hardening item ships with a test that proves it

A claim that the sandbox blocks something is backed by a test in the conformance
suite that attempts it and observes nothing. A hardening item without a passing
test does not exist.

- **Why.** Browser behavior changes across versions and engines, and egress
  paths are easy to miss by inspection. Only an executed probe shows the wall is
  really there, and keeps it there as browsers move.
- **Rules out.** "We set the CSP, so it's blocked" without a probe; hardening
  described in a doc but not exercised; a fix landed without first writing the
  test that failed.

## 6. Measured over assumed

Browser isolation facts are decided by running the probe on the engines we
support, not by reading a spec or assuming parity across engines. Where engines
differ, we harden for the weakest and record the measurement.

- **Why.** CSP directives are honored unevenly, and sandbox and frame rules have
  engine-specific gaps. An assumption that is wrong in one engine is a hole in
  production.
- **Rules out.** Relying on a single directive that one engine ignores; trusting
  that two engines behave the same; shipping a hardening item we have not seen
  pass and fail.

## 7. Host-agnostic outside, protocol-pluggable inside

The core knows nothing about any particular host app or vendor. It exposes
mechanisms and takes a config; the host supplies theme tokens, callbacks and
policy. Inside, the protocol an adapter speaks is swappable behind a thin seam;
MCP Apps is the first and default adapter.

- **Why.** The library is meant to be embedded by many apps. Baking one app's
  assumptions, or one protocol's object model, into the core makes it that app's
  library, not everyone's.
- **Rules out.** Importing a host's types into the core; a core that only works
  with one framework; tying the core to one protocol SDK's class hierarchy.

## 8. The host owns product policy; the surface stays small

Porthole decides mechanism (how isolation and gating work); the host decides
policy (whether to confirm an action, what the confirmation says, which origins
are allowed, what the theme is). We prefer deleting options to adding them, and
presets over knobs.

Authentication and authorization *policy* are the host's; carrying the host's
decision safely onto the content domain is Porthole's *mechanism*. Porthole never
knows who someone is or what they may see: the host decides before it issues a
ticket and on every request after (`authorize`), and Porthole carries that decision
in tickets and cookies, opaque to it (P046, P050).

- **Why.** Policy is product-specific and changes faster than mechanism. A small,
  opinionated surface with safe presets is easier to audit and harder to misuse
  than a large configurable one.
- **Rules out.** Drawing our own confirmation UI the host can't control; config
  options that exist only to avoid a decision; a second way to do something the
  presets already cover; users, roles, share lists or revocation lists inside
  Porthole.

## 9. No special first user

Porthole is built as a general library. Its first adopter is a normal consumer of
the public API, not a privileged case with private hooks. If the first user needs
something, it goes into the config or an extension point that any host could use.

- **Why.** A library shaped around one caller's internals is not reusable, and
  the shortcuts leak that caller's assumptions into the core (against PRINCIPLE
  7).
- **Rules out.** An escape hatch only the first host uses; branching on who the
  caller is; features reachable only through internal, undocumented API.

## 10. The agent manual is a first-class output, from day one

The shell is designed together with the manual that teaches an agent to write for
it. Guide generation is part of the framework layer, not an afterthought: every
preset ships an agent-facing manual and a tool description generated from the
same config as the sandbox and the shell.

- **Why.** Untrusted HTML is only as good as what the author was told — the sizes
  that read on each screen, the theme variables that exist, what the sandbox
  forbids. A shell without a matching manual produces content that is almost
  right, and the manual must track the shell automatically to stay true.
- **Rules out.** Shipping a shell and leaving the manual to each host; a manual
  that lists variables or limits the shell does not actually enforce; prose
  guidance that no test checks against real renders.

## Objectives

What Porthole is for and how we know it does it. OBJECTIVE n is cited by its number.

### What Porthole is for

Any app that wants the "show content made by an agent" ability — like the inline
visuals and standalone pages in ChatGPT and the Claude app — should be able to
embed Porthole and get a working, safe display out of the box, plus the manual
that teaches the agent to write for it.

The subject, stated generally, is **HTML drawn by an agent that may optionally
interact with the agent** — and that interaction is just one host function among
several. "Out of the box" means: a host picks a preset, passes theme tokens and
callbacks, and receives a safe display plus a generated agent manual.

### Objectives and success criteria

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

### Non-goals

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

### Who the users are

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
