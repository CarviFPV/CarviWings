/**
 * The radio, fetched from here instead of from the browser. Development only.
 *
 * SomaFM's stream servers answer 403 to any request whose `Referer` names
 * localhost. A media element sends the page's origin as its `Referer` and
 * offers no way to suppress it — `referrerPolicy` is not part of
 * `HTMLMediaElement` — so a page served from `http://localhost:3000` is turned
 * away by every mirror of every station and the session is silent. The same
 * page on `127.0.0.1` is served normally, and so is a deployed origin.
 *
 * A request made from the server carries no `Referer` at all, so this route
 * fetches the mirror and pipes it back to the page. The body is streamed
 * rather than buffered: this is a live stream with no end, and reading it to
 * completion would never return.
 *
 * It is off in production deliberately. Nothing there needs it — a real origin
 * was never refused — and a serverless function holding a continuous audio
 * connection open per listener is the wrong shape and the wrong bill.
 *
 * `route.web.ts`, not `route.ts`: the desktop build is a static export and
 * cannot carry route handlers, and `pageExtensions` in `next.config.ts` is what
 * leaves this file out of it. The packaged application does not need it either
 * — it sends no Referer at all, see `app/layout.tsx`.
 */

import { isMusicStreamUrl } from "@/sim/audio/musicDirector";

/** A live stream is never the same twice; nothing here may be cached. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }

  const source = new URL(request.url).searchParams.get("src") ?? "";
  // Whatever arrives here would otherwise be handed straight to the network,
  // so only the mirrors this project actually plays get through.
  if (!isMusicStreamUrl(source)) {
    return new Response("Not a stream this simulator plays", { status: 400 });
  }

  try {
    const upstream = await fetch(source, { cache: "no-store", redirect: "follow" });
    if (!upstream.ok || !upstream.body) {
      return new Response(`The station returned ${upstream.status}`, {
        status: 502,
      });
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "audio/mpeg",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error("[fpv] radio proxy failed", error);
    return new Response("The station could not be reached.", { status: 502 });
  }
}
