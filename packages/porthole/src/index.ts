/**
 * `@botiverse/porthole`: the framework-agnostic core. One config (a preset's) compiles into the
 * frame's policies, the shell, and the agent manual; the host mounts displays under it.
 */

// The config and its vocabulary.
export {
  CAPABILITIES,
  CAPABILITY_NAMES,
  MAX_COPY_CHARS,
  capabilitySpec,
  isCapabilityName,
  type CapabilityArgs,
  type CapabilityName,
  type CapabilityResults,
  type CapabilitySpec,
  type Gate,
  type HandledCapability,
} from "./config/capabilities.ts";
export type {
  CapabilityConfig,
  CapabilityMap,
  ColorScheme,
  DisplayMode,
  EgressConfig,
  EmbedderConfig,
  GuideConfig,
  IsolationKind,
  LayoutConfig,
  Limits,
  PortholeConfig,
  StorageConfig,
  ThemeConfig,
  ThemeValue,
} from "./config/schema.ts";
export {
  BUILT_IN_TOPICS,
  ConfigError,
  isOriginSource,
  originSourceProblem,
  validateConfig,
} from "./config/validate.ts";
export {
  URL_PERMISSIONS,
  URL_SANDBOX_EXTRAS,
  type UrlPermission,
  type UrlSandboxExtra,
} from "./config/schema.ts";
export { hostOriginProblem, isHostOrigin } from "./isolation/served.ts";
export { FRAME_STATUS_METHOD } from "./isolation/types.ts";

// Presets.
export {
  LIBRARY_CDNS,
  presets,
  type PresetName,
  type PresetOptions,
  type UrlPresetOptions,
} from "./presets/presets.ts";

// The compiler.
export { compile, type CompiledConfig } from "./compile/compile.ts";
export {
  allEgressOrigins,
  declaredCapabilities,
  effectiveGates,
  egressOrigins,
  embedderCsp,
  embedderFrameSourcesOf,
  type CspDirective,
  type EgressKind,
} from "./compile/policy.ts";
export { shellPlan, type ShellPlan } from "./shell/plan.ts";
export type { ShellDocumentOptions } from "./shell/document.ts";
export {
  generateGuide,
  generateToolDescription,
  type BuiltInTopic,
  type GuideTopic,
} from "./guide/guide.ts";
export { GUIDE_EXAMPLES, type GuideExample } from "./guide/examples.ts";

// Theme.
export {
  CHART_PALETTE,
  DEFAULT_THEME,
  DEFAULT_THEME_EVENT,
  DEFAULT_THEME_VARIABLES,
  resolveTheme,
  themeDefault,
} from "./theme/variables.ts";

// The seams: isolation, platform, transport, protocol, bridge, host.
export type {
  FrameLocation,
  FrameSource,
  InstanceLocator,
  InstanceRef,
  ServedDocument,
} from "./isolation/types.ts";
export type { PlatformHost, Surface, SurfaceSpec } from "./platform/types.ts";
export type { Transport } from "./transport/types.ts";
export type {
  AdapterConnection,
  AdapterEvent,
  AdapterSession,
  ProtocolAdapter,
  ShellConnection,
} from "./protocol/adapter.ts";
export {
  COPY_TEXT_METHOD,
  MCP_APPS_METHODS,
  MCP_APPS_PROTOCOL_VERSION,
  MCP_APPS_STYLE_VARIABLES,
  PORTHOLE_STYLES,
  type HostContext,
} from "./protocol/mcp-apps.ts";
export type {
  CallContext,
  CallOutcome,
  CapabilityHandler,
  CapabilityHandlers,
  Confirm,
  ConfirmAnswer,
  ConfirmRequest,
  Proceed,
  HostFunctionBridge,
  Refusal,
} from "./bridge/types.ts";
export { createHost } from "./host/create-host.ts";
export { writeClipboard } from "./host/clipboard.ts";
export type {
  AnnotationControls,
  DisplayControls,
  DisplayEvents,
  FrameBlock,
  FrameOutcome,
  DisplayHandle,
  HostOptions,
  MountOptions,
  PortholeHost,
} from "./host/types.ts";

// Annotations (P053): anchors, what a frame reports, and the host's checks on both.
export {
  ANNOTATE_METHODS,
  ANNOTATION_LIMITS,
  type AnchorResult,
  type AnchorState,
  type AnnotateMode,
  type AnnotationAnchor,
  type AnnotationMark,
  type AnnotationRect,
  type AnnotationReport,
  type AnnotationSelector,
  type CssSelector,
  type TextPositionSelector,
  type TextQuoteSelector,
} from "./annotate/types.ts";
export { parseAnchor, parseRect, parseReport } from "./annotate/validate.ts";
