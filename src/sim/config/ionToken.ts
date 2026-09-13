/**
 * What a Cesium ion access token looks like, and which one is in force.
 *
 * The simulator can be given its token two ways: built into the bundle from
 * the environment, which is what a developer running it from a checkout does,
 * or typed into the application itself, which is what somebody who downloaded
 * a build and opened it does. Neither belongs in this module — one is Next's
 * build-time inlining and the other is browser storage — but deciding between
 * them, and working out whether a pasted string could be a token at all, is
 * plain text handling and lives here where it can be tested.
 *
 * Nothing here logs or formats the token itself: `describeIonToken` is the one
 * function that says anything about a configured token, and it says only how
 * long it is and where it came from.
 */

export const ION_TOKEN_SOURCE = {
  /** Typed into the application, and kept in this browser. */
  Entered: "entered",
  /** Inlined into the bundle from the environment when it was built. */
  Environment: "environment",
  None: "none",
} as const;

export type IonTokenSource =
  (typeof ION_TOKEN_SOURCE)[keyof typeof ION_TOKEN_SOURCE];

/** The token in force, and which of the two ways in it arrived by. */
export interface IonTokenChoice {
  readonly token: string | null;
  readonly source: IonTokenSource;
}

/**
 * A `NAME=` in front of the token, from a copied `.env` line.
 *
 * Deliberately only matches an all-caps name: a token's own first block is
 * mixed-case base64 and can end in `=` padding, so a looser pattern would
 * happily eat the first third of a perfectly good token.
 */
const ENV_ASSIGNMENT = /^[A-Z][A-Z0-9_]*\s*=\s*/;

/** What an ion token is made of: three base64url blocks, full stops between. */
const TOKEN_SHAPE = /^[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+$/;

/** The shortest string worth treating as a token rather than as a slip. */
const PLAUSIBLE_LENGTH = 40;

/**
 * Cleans up a pasted token.
 *
 * A token is copied out of a web page, an email, a terminal or a `.env` file,
 * and arrives wrapped in whatever that copy brought with it: surrounding
 * quotes, a `NEXT_PUBLIC_CESIUM_ION_TOKEN=` in front, a trailing newline, or
 * line breaks from a window that wrapped it. None of that is part of the
 * token, and a token with a stray newline in it fails against ion in a way
 * that reads like a wrong token rather than a mangled one, so it is all taken
 * off here rather than left for the pilot to spot.
 */
export function normaliseIonToken(raw: unknown): string {
  if (typeof raw !== "string") return "";

  let text = raw.trim().replace(ENV_ASSIGNMENT, "").trim();

  // Paired quotes only: a lone quote is a character in a string that was never
  // a token anyway, and leaving it in makes the complaint below truthful.
  const first = text[0];
  if (
    text.length >= 2 &&
    (first === '"' || first === "'" || first === "`") &&
    text[text.length - 1] === first
  ) {
    text = text.slice(1, -1).trim();
  }

  // Any whitespace left is a line wrap: a token never contains one.
  return text.replace(/\s+/g, "");
}

/**
 * Whether a cleaned-up token looks like one, and if not, what is wrong.
 *
 * Advisory rather than a gate. The check is on the shape ion's tokens have
 * today, and a token that does not match it is far more often a copy that went
 * wrong than a format that changed — but the only authority on whether a token
 * works is ion, so a pilot who is sure is still allowed to save it.
 */
export function ionTokenComplaint(token: string): string | null {
  if (token.length === 0) return "Paste the access token from your ion account.";
  if (!TOKEN_SHAPE.test(token)) {
    return "That does not look like an ion access token: they are three blocks of letters and digits with full stops between them. Check you copied the whole thing.";
  }
  if (!token.startsWith("eyJ")) {
    return "An ion access token normally starts with “eyJ”. This one does not — it may be an asset ID or a client ID rather than a token.";
  }
  if (token.length < PLAUSIBLE_LENGTH) {
    return "That is much shorter than an ion access token. Check you copied the whole thing.";
  }
  return null;
}

/**
 * Picks the token to fly on.
 *
 * The typed one wins. A build that carries a token from its environment is
 * carrying a default, and somebody who has since typed their own into this
 * browser has said which one they want used; the alternative would be a
 * setting the application ignores.
 */
export function resolveIonToken(
  entered: string | null,
  environment: string | null,
): IonTokenChoice {
  if (entered) return { token: entered, source: ION_TOKEN_SOURCE.Entered };
  if (environment) {
    return { token: environment, source: ION_TOKEN_SOURCE.Environment };
  }
  return { token: null, source: ION_TOKEN_SOURCE.None };
}

/**
 * A non-identifying fingerprint, for the debug overlay.
 *
 * Enough to tell *which* token is loaded and how it got there without the
 * value ever being displayed.
 */
export function describeIonToken(choice: IonTokenChoice): string {
  if (!choice.token) return "not configured";
  const where =
    choice.source === ION_TOKEN_SOURCE.Entered ? "entered" : "environment";
  return `configured, ${where} (${choice.token.length} chars)`;
}
