import { test } from "@playwright/test";
import { defineLeakSuite } from "../src/conformance/index.ts";
import { referenceHost } from "./reference-host.ts";

defineLeakSuite(test, referenceHost);
