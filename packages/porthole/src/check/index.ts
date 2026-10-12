/**
 * `@botiverse/porthole/check`: check content before people see it (P073). `checkPage` runs it in
 * the real sandbox through a driver (`playwrightDriver`, `cdpDriver`); `lintContent` and the tool
 * definitions are in the core (`@botiverse/porthole`), since they need no browser.
 */
export {
  checkPage,
  type CheckCall,
  type CheckDriver,
  type CheckOptions,
  type CheckReport,
  type CheckRun,
  type CheckSession,
} from "./check.ts";
export {
  CHECK_CONTENT_DOMAIN,
  CHECK_ORIGIN,
  cdpDriver,
  playwrightDriver,
  type CdpSession,
} from "./drivers.ts";
export { lintContent, type Finding, type LintRule } from "./lint.ts";
