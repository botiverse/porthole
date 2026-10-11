/** Thrown by an interface whose implementation lands in a later milestone (see DESIGN.md). */
export class NotBuiltYet extends Error {
  constructor(what: string, milestone: string) {
    super(`${what} is not built yet (${milestone}; see DESIGN.md § Milestones)`);
    this.name = "NotBuiltYet";
  }
}
