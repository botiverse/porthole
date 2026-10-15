/**
 * Porthole's vendored libraries (P079): a small fixed set, pinned, copied byte for byte from their
 * npm packages when Porthole is built (`scripts/vendor-libraries.ts`), and served by `/server` on
 * every content origin under `LIBRARY_PATH`. A config that sets `egress.libraries` loads scripts
 * from there (its own origin) and the manual teaches the lines below; nothing else is fetched.
 *
 * A path, once released, keeps serving the same bytes: a new version is a new path beside it.
 */

/** Where the libraries are served on a content origin (inside Porthole's reserved prefix). */
export const LIBRARY_PATH = "/__porthole/lib/";

export interface VendoredLibrary {
  /** What the manual calls it. */
  readonly title: string;
  /** The npm package. */
  readonly name: string;
  /** Its exact version (published at least two weeks before it was vendored). */
  readonly version: string;
  /** The file served, as a path inside the package (a classic script: it defines `global`). */
  readonly file: string;
  /** The global the script defines. */
  readonly global: string;
  /** Its license (SPDX), and the package's license file, served beside it. */
  readonly license: string;
  readonly licenseFile: string;
  /** What it is for, for the manual. */
  readonly use: string;
}

/**
 * What agent-made widgets reach for most: Chart.js for charts, D3 for anything drawn from data
 * (scales, axes, shapes, time and number formats). Both run as classic scripts.
 */
export const VENDORED_LIBRARIES: readonly VendoredLibrary[] = [
  {
    title: "Chart.js",
    name: "chart.js",
    version: "4.5.1",
    file: "dist/chart.umd.min.js",
    global: "Chart",
    license: "MIT",
    licenseFile: "LICENSE.md",
    use: "charts",
  },
  {
    title: "D3",
    name: "d3",
    version: "7.9.0",
    file: "dist/d3.min.js",
    global: "d3",
    license: "ISC",
    licenseFile: "LICENSE",
    use: "scales, axes, shapes, time and number formats",
  },
];

/** Where a library's file is served, on the frame's own origin. */
export const libraryPath = (library: VendoredLibrary): string =>
  `${LIBRARY_PATH}${library.name}@${library.version}/${library.file}`;

/** Where its license is served, beside it. */
export const licensePath = (library: VendoredLibrary): string =>
  `${LIBRARY_PATH}${library.name}@${library.version}/${library.licenseFile}`;
