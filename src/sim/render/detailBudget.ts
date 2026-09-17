/**
 * What a zoomed view costs the world behind it.
 *
 * A renderer that streams its world decides how finely to draw a tile by
 * projecting the tile's error onto the screen and refining until what is left
 * is smaller than a threshold in pixels. That threshold is the quality preset:
 * "no more than two pixels of error", and it is honoured at any field of view,
 * because the projection has the field of view in it.
 *
 * Which is exactly right and exactly the problem. Narrowing the view magnifies
 * everything in it, so the same tile now covers more pixels and its error with
 * it, and the renderer answers by fetching finer tiles — across the whole view,
 * not just around whatever the narrowing was for. The relationship is the
 * tangent of the half-angle, so it is not gentle: an eye that closes from
 * sixty-five degrees down to fifteen asks for about five times the detail it
 * was asking for a moment ago, and asks for it again every time it opens and
 * closes.
 *
 * The RC ground view does precisely that, several times a minute, because the
 * pilot's eye narrows onto a model going away and opens again as it comes home.
 * The far hillside is not what the narrowing was for — nobody standing on a
 * field resolves more of the next valley by squinting at their wing — so the
 * view is magnified and the world is left at the detail the wide view was
 * drawn at. Everything on screen is bigger, including the softness; what it is
 * not is five times the tiles, fetched over the top of a flight in progress.
 *
 * This is the whole of that decision, and it is a single number: how many times
 * narrower the view is than a plain one, which is how much the threshold may be
 * relaxed to leave the tiles chosen where they were.
 */

const DEG_TO_RAD = Math.PI / 180;

/**
 * How much a view of `fovDeg` magnifies the world against one of `wideFovDeg`.
 *
 * 1 for a view that is not narrowed, and never less: a view *wider* than the
 * plain one is not a reason to draw the world more finely than the pilot asked
 * for. Degenerate angles — zero, negative, past a straight line, not a number —
 * are treated as no zoom at all rather than as a licence to change anything.
 */
export function viewMagnification(fovDeg: number, wideFovDeg: number): number {
  if (!Number.isFinite(fovDeg) || !Number.isFinite(wideFovDeg)) return 1;
  if (fovDeg <= 0 || wideFovDeg <= 0) return 1;
  if (fovDeg >= 180 || wideFovDeg >= 180) return 1;
  // The renderer's own figure is 2 tan(fovy/2), and a widescreen frustum
  // divides that by the aspect ratio — which cancels in the ratio, so the
  // magnification is the same number on any shape of window.
  const narrow = Math.tan(fovDeg * 0.5 * DEG_TO_RAD);
  const wide = Math.tan(wideFovDeg * 0.5 * DEG_TO_RAD);
  if (narrow <= 0 || wide <= 0) return 1;
  return Math.max(1, wide / narrow);
}
