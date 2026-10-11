import { test } from "@playwright/test";
import { defineServedSuite } from "../../src/conformance/served.ts";
import { servedHost } from "./harness.ts";

/** The served-mode cases against Porthole's reference serving (`/server` and a minimal host). */
defineServedSuite(test, servedHost);
