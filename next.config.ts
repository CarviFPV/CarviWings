import type { NextConfig } from "next";

/**
 * Whether this is the build that goes inside the desktop application.
 *
 * The desktop shell (see `src-tauri/`) has no Node process behind the page: it
 * hands the webview a directory of files. So that build is a static export, and
 * a static export cannot carry route handlers. The two the simulator has are
 * therefore named `route.web.ts` and only counted as routes when `web.ts` is in
 * `pageExtensions` — which it is here and is not below. Nothing else moves: the
 * same `page.tsx` and the same components are built either way.
 *
 * `src/lib/desktop/runtime.ts` is the other half of the arrangement, and covers
 * what those two routes did for the pages that used them.
 */
const desktopExport = process.env.DESKTOP_EXPORT === "1";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // CesiumJS is loaded at runtime from its own prebuilt browser bundle (see
  // src/lib/cesium/loadCesium.ts), so it is never imported by the application
  // bundle. This keeps it out of the server graph as well, belt and braces.
  serverExternalPackages: ["cesium"],
  ...(desktopExport
    ? { output: "export" as const, pageExtensions: ["tsx", "ts", "jsx", "js"] }
    : { pageExtensions: ["web.ts", "tsx", "ts", "jsx", "js"] }),
  // Develop against http://127.0.0.1:3000, not http://localhost:3000.
  //
  // The radio streams are SomaFM's, and their servers refuse — 403, which the
  // browser reports as an unsupported source — any request whose Referer names
  // localhost. A media element sends the page's origin as its Referer and
  // cannot be told not to, so on localhost every mirror of every station is
  // turned away and the session is silent. The same page over the loopback
  // address is served normally. Nothing else cares, and a deployed origin was
  // never affected.
  //
  // Next serves its dev resources only to origins it has been told about, so
  // the address has to be named here. Development only: no effect on a build.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
