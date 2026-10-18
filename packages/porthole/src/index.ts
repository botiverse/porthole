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
export { PASSIVE_KINDS, type PassiveKind } from "./config/schema.ts";
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
  type LiveWidgetOptions,
  type PresetOptions,
  type UrlPresetOptions,
} from "./presets/presets.ts";
export {
  LIBRARY_PATH,
  VENDORED_LIBRARIES,
  libraryPath,
  licensePath,
  type VendoredLibrary,
} from "./libraries/libraries.ts";

// A version made of files (P081): the rules its paths follow, its limits and its types.
export {
  checkFileSet,
  DEFAULT_ENTRY,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_VERSION_BYTES,
  fileLimits,
  filePathProblem,
  lookupFile,
  requestFilePath,
  servesFiles,
  type FileLimits,
  type FileLookup,
  type FileSetProblem,
} from "./files/paths.ts";
export {
  fileTypeOf,
  KNOWN_EXTENSIONS,
  UNKNOWN_TYPE,
  type FileRole,
  type FileType,
} from "./files/types.ts";

// The compiler.
export { compile, type CompiledConfig } from "./compile/compile.ts";
export {
  allEgressOrigins,
  anyHttps,
  declaredCapabilities,
  effectiveGates,
  egressOrigins,
  embedderCsp,
  embedderFrameSourcesOf,
  FILE_SET_DIRECTIVES,
  fileSetCspDirectives,
  INERT_FILE_CSP,
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
  NAVIGATING_METHOD,
  NAVIGATION_BLOCKED_METHOD,
  PORTHOLE_STYLES,
  STALE_META,
  type HostContext,
} from "./protocol/mcp-apps.ts";
// Why a call was refused, as content is told it, and the host's own refusals (P080).
export {
  REFUSAL_CODES,
  Refused,
  isRefused,
  type RefusalCode,
  type RefusalReason,
} from "./bridge/refusal.ts";
export type {
  CallContext,
  CallOptions,
  CallOutcome,
  CapabilityHandler,
  CapabilityHandlers,
  Confirm,
  ConfirmAnswer,
  ConfirmDisplay,
  ConfirmRequest,
  Consent,
  DataCache,
  Proceed,
  HostFunctionBridge,
  Refusal,
  SubscriptionContext,
} from "./bridge/types.ts";
export { createHost } from "./host/create-host.ts";
// The client half of the host kit, and the display registry (P072).
export {
  entryTarget,
  frameFallback,
  portholeClient,
  type ContentClientMeta,
  type FrameFallback,
  type PortholeClient,
  type PortholeClientOptions,
} from "./host/client.ts";
export { defineDisplays, type DisplayKind, type Displays } from "./displays/displays.ts";
// The agent's side: what content can be told without running it, and its tools (P073).
export { fragmentOf, lintContent, type Finding, type LintRule } from "./check/lint.ts";
// A page that comes with files (P081): its lint, without running it.
export { lintFiles, type FileContents, type FileFinding } from "./check/files.ts";
export {
  admitContent,
  admitFiles,
  type AdmitFilesResult,
  answerGuide,
  checkTool,
  guideChanges,
  guideTool,
  guideTopics,
  showTool,
  type AdmitResult,
  type JsonSchema,
  type ToolDefinition,
} from "./check/tools.ts";
export { writeClipboard } from "./host/clipboard.ts";
export {
  httpLocator,
  LocateError,
  servedOrOpaque,
  type HttpLocatorOptions,
  type ServedMeta,
} from "./host/locator.ts";
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
