# Principles

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

- **Why.** Policy is product-specific and changes faster than mechanism. A small,
  opinionated surface with safe presets is easier to audit and harder to misuse
  than a large configurable one.
- **Rules out.** Drawing our own confirmation UI the host can't control; config
  options that exist only to avoid a decision; a second way to do something the
  presets already cover.

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
