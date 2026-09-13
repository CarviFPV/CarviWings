import { assert, suite } from "./harness";
import {
  ION_TOKEN_SOURCE,
  describeIonToken,
  ionTokenComplaint,
  normaliseIonToken,
  resolveIonToken,
} from "../config/ionToken";

/** Shaped like an ion token, and not one: three base64url blocks. */
const TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJqdGkiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAifQ." +
  "c2lnbmF0dXJlLWdvZXMtaGVyZQ";

export function runIonTokenTests(): void {
  suite("a pasted token arrives with whatever the copy brought with it", () => {
    assert(
      normaliseIonToken(`  ${TOKEN}\n`) === TOKEN,
      "surrounding whitespace and a trailing newline come off",
    );
    assert(
      normaliseIonToken(`"${TOKEN}"`) === TOKEN &&
        normaliseIonToken(`'${TOKEN}'`) === TOKEN,
      "so do paired quotes",
    );
    assert(
      normaliseIonToken(`NEXT_PUBLIC_CESIUM_ION_TOKEN=${TOKEN}`) === TOKEN,
      "and a copied .env line loses its variable name",
    );
    assert(
      normaliseIonToken(`NEXT_PUBLIC_CESIUM_ION_TOKEN="${TOKEN}"`) === TOKEN,
      "even when the value in it was quoted",
    );
    const wrapped = `${TOKEN.slice(0, 30)}\n${TOKEN.slice(30)}`;
    assert(
      normaliseIonToken(wrapped) === TOKEN,
      "a token broken across lines by a narrow window is put back together",
    );
  });

  suite("cleaning up a token never eats part of one", () => {
    assert(normaliseIonToken(TOKEN) === TOKEN, "a clean token is left alone");
    // The all-caps rule on the assignment pattern is what protects this: a
    // token's first block is mixed case and can end in `=` padding.
    const padded = "eyJhbGciOiJIUzI1NiI=.eyJqdGkiOiIxIn0=.c2lnbmF0dXJl";
    assert(
      normaliseIonToken(padded) === padded,
      "base64 padding in the first block is not mistaken for an assignment",
    );
    assert(normaliseIonToken(undefined) === "", "and a non-string is nothing");
    assert(normaliseIonToken("   ") === "", "as is a field with only spaces");
  });

  suite("a token that cannot be one says so, without refusing it", () => {
    assert(ionTokenComplaint(TOKEN) === null, "a well-formed token passes");
    assert(
      ionTokenComplaint("") !== null,
      "an empty field is asked to be filled in",
    );
    assert(
      ionTokenComplaint("1234567") !== null,
      "an asset ID pasted by mistake is questioned",
    );
    assert(
      ionTokenComplaint(TOKEN.split(".").slice(0, 2).join(".")) !== null,
      "so is a token missing its last block",
    );
    assert(
      ionTokenComplaint(`abc.${TOKEN.split(".")[1]}.def`) !== null,
      "and one that does not start the way ion's tokens do",
    );
  });

  suite("the token typed into the application wins", () => {
    const entered = resolveIonToken(TOKEN, "environment-token");
    assert(entered.token === TOKEN, "a typed token is the one used");
    assert(
      entered.source === ION_TOKEN_SOURCE.Entered,
      "and it is known to have come from the pilot",
    );

    const built = resolveIonToken(null, "environment-token");
    assert(
      built.token === "environment-token" &&
        built.source === ION_TOKEN_SOURCE.Environment,
      "a build that carries one falls back to it",
    );

    const nothing = resolveIonToken(null, null);
    assert(
      nothing.token === null && nothing.source === ION_TOKEN_SOURCE.None,
      "and an installation with neither has no world to fly over",
    );
  });

  suite("what is said out loud about a token is never the token", () => {
    const description = describeIonToken(resolveIonToken(TOKEN, null));
    assert(
      !description.includes(TOKEN) && !description.includes(TOKEN.slice(0, 12)),
      "the debug overlay never gets the value itself",
    );
    assert(
      description.includes(String(TOKEN.length)) &&
        description.includes("entered"),
      "only its length and where it came from",
    );
    assert(
      describeIonToken(resolveIonToken(null, null)) === "not configured",
      "and an installation without one says exactly that",
    );
  });
}
