// The app's display kinds, in one place (defineDisplays): the server serves under them, the page
// frames under them, and the agent's tools and manual come from them. Shared by the server, the
// page (served to it as a module) and the agent's tools (examples/mcp).
import { defineDisplays } from "@botiverse/porthole";

/** The kinds as plain data: the server also hands them to the page as a module. */
export const kinds = {
  // A stored page: a kind named "artifact" is the preset an artifact instance names by default.
  artifact: {
    preset: "artifact",
    options: {
      // A whole-page viewer: the frame fills its box, and the agent's manual says so.
      layout: { kind: "fill" },
      guide: { toolName: "show_page", guideToolName: "page_guide" },
    },
  },
};

export const displays = defineDisplays(kinds);
