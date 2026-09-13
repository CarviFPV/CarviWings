import type { Metadata, Viewport } from "next";
import "./globals.css";

import { IS_DESKTOP_BUILD } from "@/lib/desktop/runtime";

export const metadata: Metadata = {
  title: "CarviWings",
  description:
    "A browser FPV fixed-wing interception simulator flown over the real Earth.",
  // The desktop application sends no Referer at all, for the radio's sake.
  //
  // SomaFM's servers answer 403 to any request whose Referer names localhost,
  // and a native webview serves the page from `tauri.localhost` — which it does
  // not let the page rename, and which a media element would send along with
  // every request for a stream. A request with no Referer is served normally,
  // and this is the one way a media element can be made to send none. Nothing
  // else the simulator fetches looks at it.
  //
  // Only in the packaged build: a deployed origin was never refused, and an
  // ion token restricted by referrer would stop working if it were.
  ...(IS_DESKTOP_BUILD ? { referrer: "no-referrer" as const } : {}),
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#04060a",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="h-full bg-void text-osd antialiased">{children}</body>
    </html>
  );
}
