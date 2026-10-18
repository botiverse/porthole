// Porthole capability runtime, contract 1: user. Declare it: { user: {} }.

/** Who is viewing, as the app says. */
interface PortholeUserInfo {
  /** The app's id for this person (whose data "data/users/me" is), or null if it gives none. */
  readonly id: string | null;
  readonly name: string | null;
  /** What they may do here: view < interact < admin < owner. */
  readonly level: "view" | "interact" | "admin" | "owner";
}

interface PortholeUser {
  /** Level: view. */
  get(): Promise<PortholeUserInfo>;
}

interface PortholeCapabilities {
  user: PortholeUser;
}
