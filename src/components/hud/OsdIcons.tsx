/**
 * The OSD's glyphs.
 *
 * A flight controller's on-screen display has no room for words, so it says
 * what a number is with a picture: a dial for speed, a house for the way home,
 * a cell for the pack. These are those pictures — drawn on a twelve-by-twelve
 * grid with `shapeRendering="crispEdges"`, because the character generator
 * they stand in for has whole pixels and no anti-aliasing, and a glyph that
 * looks drawn rather than rendered is the whole difference between an OSD and
 * an overlay.
 *
 * Every one is sized in `em` and painted in `currentColor`, so a glyph takes
 * the size and the tone of the readout it sits in without being told either.
 */

import type { SVGProps } from "react";

/** Side of the box every glyph is drawn in, in `em` of the readout's text. */
const GLYPH_EM = "1.15em";

function Glyph({
  children,
  ...rest
}: SVGProps<SVGSVGElement> & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width={GLYPH_EM}
      height={GLYPH_EM}
      aria-hidden
      focusable="false"
      shapeRendering="crispEdges"
      className="shrink-0 self-center"
      style={{
        // The glyphs carry the same black outline the text does, which
        // `-webkit-text-stroke` cannot give them.
        filter:
          "drop-shadow(1px 0 0 rgba(0,0,0,.9)) drop-shadow(-1px 0 0 rgba(0,0,0,.9)) drop-shadow(0 1px 0 rgba(0,0,0,.9)) drop-shadow(0 -1px 0 rgba(0,0,0,.9))",
      }}
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Speed: a dial with the needle round at the fast end. */
export function SpeedGlyph() {
  return (
    <Glyph>
      <path
        d="M1 8a5 5 0 0 1 10 0h-2a3 3 0 0 0-6 0Z"
        fill="currentColor"
        shapeRendering="auto"
      />
      <path d="M6 8 9 4" stroke="#ff4d4d" strokeWidth="1.6" strokeLinecap="round" shapeRendering="auto" />
    </Glyph>
  );
}

/** Height above the ground: arrowheads closing on the line you clear. */
export function AltitudeGlyph() {
  return (
    <Glyph>
      <path d="M0 5h3v2H0Z M12 5H9v2h3Z" fill="currentColor" />
      <path d="M4 3v6l3-3Z" fill="currentColor" shapeRendering="auto" />
      <path d="M4 1h5v1H4Z M4 10h5v1H4Z" fill="currentColor" />
    </Glyph>
  );
}

/** Height above the launch: the same, over a ground line. */
export function AglGlyph() {
  return (
    <Glyph>
      <path d="M5 1h2v7H5Z" fill="currentColor" />
      <path d="M6 0 2 4h8Z" fill="currentColor" shapeRendering="auto" />
      <path d="M0 10h12v2H0Z" fill="currentColor" />
    </Glyph>
  );
}

/** Going up or coming down. */
export function VerticalSpeedGlyph({ climbing }: { climbing: boolean }) {
  return (
    <Glyph>
      {climbing ? (
        <path d="M6 1 1 8h10Z" fill="currentColor" shapeRendering="auto" />
      ) : (
        <path d="M6 11 1 4h10Z" fill="currentColor" shapeRendering="auto" />
      )}
    </Glyph>
  );
}

/** The launch point. */
export function HomeGlyph() {
  return (
    <Glyph>
      <path d="M6 0 0 5h2v7h8V5h2Z" fill="none" stroke="currentColor" strokeWidth="1.4" shapeRendering="auto" />
    </Glyph>
  );
}

/** The pack, drawn with as much of it left as there is. */
export function BatteryGlyph({ charge }: { charge: number }) {
  const level = Math.max(0, Math.min(1, charge));
  return (
    <Glyph>
      <path d="M0 2h9v8H0Z" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 4h2v4h-2Z" fill="currentColor" />
      <rect
        x="1.6"
        y={3.6 + (1 - level) * 4.8}
        width="5.8"
        height={level * 4.8}
        fill="currentColor"
      />
    </Glyph>
  );
}

/** What the motor is pulling. */
export function CurrentGlyph() {
  return (
    <Glyph>
      <path d="M7 0 2 7h3l-1 5 6-7H7Z" fill="currentColor" shapeRendering="auto" />
    </Glyph>
  );
}

/** How hard the stick is being held. */
export function ThrottleGlyph() {
  return (
    <Glyph>
      <path d="M1 10h10v2H1Z" fill="currentColor" />
      <path d="M2 6h2v3H2Z M5 3h2v6H5Z M8 0h2v9H8Z" fill="currentColor" />
    </Glyph>
  );
}

/** Time on the clock. */
export function TimerGlyph() {
  return (
    <Glyph>
      <circle cx="6" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" shapeRendering="auto" />
      <path d="M6 4v3h3" fill="none" stroke="currentColor" strokeWidth="1.4" shapeRendering="auto" />
      <path d="M4 0h4v2H4Z" fill="currentColor" />
    </Glyph>
  );
}

/** The picture coming down off the aircraft. */
export function LinkGlyph() {
  return (
    <Glyph>
      <path d="M6 11a1.4 1.4 0 1 0 0-2.8A1.4 1.4 0 0 0 6 11Z" fill="currentColor" shapeRendering="auto" />
      <path d="M3 7a4 4 0 0 1 6 0" fill="none" stroke="currentColor" strokeWidth="1.3" shapeRendering="auto" />
      <path d="M1 4a7 7 0 0 1 10 0" fill="none" stroke="currentColor" strokeWidth="1.3" shapeRendering="auto" />
    </Glyph>
  );
}

/** Which way the wind is blowing, and the fact that it is. */
export function WindGlyph() {
  return (
    <Glyph>
      <path d="M0 2h8v1.4H0Z M0 5.3h11v1.4H0Z M0 8.6h6v1.4H0Z" fill="currentColor" />
    </Glyph>
  );
}

/** A contact, and how far off it is. */
export function TargetGlyph() {
  return (
    <Glyph>
      <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" shapeRendering="auto" />
      <path d="M6 0v3 M6 9v3 M0 6h3 M9 6h3" stroke="currentColor" strokeWidth="1.4" />
    </Glyph>
  );
}

/** What is left of the airframe, and how many of them. */
export function AirframeGlyph() {
  return (
    <Glyph>
      <path d="M6 1 0 9h4l2-2 2 2h4Z" fill="currentColor" shapeRendering="auto" />
      <path d="M5 9h2v3H5Z" fill="currentColor" />
    </Glyph>
  );
}

/** Load on the wing. */
export function LoadGlyph() {
  return (
    <Glyph>
      <path d="M6 0v8 M2 5l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" shapeRendering="auto" />
      <path d="M1 10h10v2H1Z" fill="currentColor" />
    </Glyph>
  );
}
