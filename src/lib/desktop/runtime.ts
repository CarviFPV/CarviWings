/**
 * Telling the desktop application apart from the web one.
 *
 * The simulator ships two ways: served from a web server, and packaged as a
 * Windows application by the Tauri shell in `src-tauri/`. The packaged build is
 * the same page, statically exported (`DESKTOP_EXPORT=1`, see
 * `next.config.ts`) and handed to a native webview — which means there is no
 * server behind it, and the two route handlers under `app/api` are not there.
 *
 * Only one of them is missed. `/api/radio` is a development convenience that a
 * packaged application never had; `/api/metar` is how the live weather is
 * fetched, and NOAA sends no allow-origin header, so a webview asking it
 * directly would be refused. The shell's own HTTP client makes that request
 * from native code instead, where CORS does not apply — `desktopFetch` below is
 * the way to it.
 *
 * `NEXT_PUBLIC_DESKTOP` is inlined at build time, so a web build has already
 * decided the answer before it runs, and the plugin behind `desktopFetch` sits
 * in a chunk that build never asks for.
 */

/** Whether this bundle was built to go inside the desktop application. */
export const IS_DESKTOP_BUILD = process.env.NEXT_PUBLIC_DESKTOP === "1";

/**
 * Whether the page is running inside the desktop shell right now.
 *
 * A desktop build opened in an ordinary browser — which is what
 * `npm run desktop:dev` serves on http://127.0.0.1:3000 while the shell window
 * is open — answers no, and every caller falls back to the web behaviour.
 */
export function isDesktopRuntime(): boolean {
  return (
    IS_DESKTOP_BUILD &&
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

/**
 * `fetch`, made by the shell rather than by the webview.
 *
 * Imported on demand so the web bundle never loads the plugin, and callable
 * only behind `isDesktopRuntime()`: outside the shell there is nothing on the
 * other end of it.
 */
export async function desktopFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const { fetch: shellFetch } = await import("@tauri-apps/plugin-http");
  return shellFetch(url, init);
}
