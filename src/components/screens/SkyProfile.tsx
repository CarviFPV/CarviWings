"use client";

/**
 * The layer viewer: the sky drawn side-on, beside the controls that build it.
 *
 * A weather panel is a list of numbers, and a list of numbers is the one thing
 * a sky is hard to read as. The question a pilot is actually asking while
 * building one — *is that deck above me or below me, and will I be inside it
 * at three hundred metres* — is a question about a vertical section, so the
 * panel draws one: an altitude axis with the ground at zero, the cloud decks
 * as bands on it, and the wind levels in a lane of their own beside them.
 *
 * Two things are deliberate about how it looks:
 *
 *   - **Cloud and wind never look alike.** Cloud is a pale filled band with a
 *     scalloped top when its genus piles up and a flat one when it does not;
 *     wind is an amber arrow on a hairline lane, pointing the way the air is
 *     going. They are two different kinds of thing measured in two different
 *     units and stacked on the same axis, and the panel that let them share a
 *     shape was the panel nobody could read.
 *   - **The ground is drawn.** Zero is the ground under the launch point, not
 *     the bottom of the picture, so a deck reported by an aerodrome down in
 *     the valley is visibly *below* the wing rather than clamped on top of it.
 *
 * All the arithmetic — where the axis starts and stops, which round numbers
 * get a tick, where each band lands — is `sim/environment/skyProfile`, which
 * knows nothing about SVG and is covered by the simulation tests. This file
 * only paints.
 */

import { useMemo } from "react";
import type { CloudType, SkyProfileBand, WeatherState } from "@/sim/environment/types";
import {
  CLOUD_TYPE_INFO,
  buildSkyProfile,
  describeWeather,
  oktasLabel,
} from "@/sim/environment/types";

// --- The page ---------------------------------------------------------------

const WIDTH = 300;
const HEIGHT = 470;
const TOP = 16;
const BOTTOM = 20;

const GUTTER_X = 32;
const AXIS_X = 38;
const CLOUD_X0 = 42;
const CLOUD_X1 = 196;
const DIVIDER_X = 204;
const WIND_X = 224;
const WIND_TEXT_X = 240;

const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;

/** A fraction down the profile, as a y in the picture. */
function pageY(fraction: number): number {
  return TOP + fraction * PLOT_HEIGHT;
}

/**
 * What each genus is painted in.
 *
 * Warmer and brighter as the cloud gets thinner and higher: nimbostratus is
 * the colour of a wet afternoon and cirrus is nearly white, which is the one
 * cue that survives being drawn at eight pixels tall.
 */
const CLOUD_COLOUR: Readonly<Record<CloudType, string>> = {
  ST: "#8ea1b2",
  SC: "#9cb2c4",
  CU: "#dbe8f4",
  TCU: "#cbdcee",
  CB: "#b6c6d8",
  NS: "#6d7b8a",
  AS: "#a8bbcb",
  CI: "#d3e9f5",
};

export interface SkyProfileViewProps {
  readonly sky: WeatherState;
  /** Ground elevation under the launch point, metres AMSL; null when unknown. */
  readonly terrainHeight: number | null;
}

export function SkyProfileView({ sky, terrainHeight }: SkyProfileViewProps) {
  const profile = useMemo(() => buildSkyProfile(sky), [sky]);

  return (
    // Capped, because the column it lives in goes full width when the panel
    // stacks on a narrow screen and a picture this tall stretched across a
    // laptop is a picture of nothing.
    <section className="mx-auto w-full max-w-[20rem] border border-hairline bg-panel/60">
      <header className="flex items-baseline justify-between border-b border-hairline px-3 py-2">
        <span className="text-2xs uppercase tracking-[0.14em] text-osd-dim">
          Layer viewer
        </span>
        <span className="flex items-center gap-3 text-2xs text-osd-faint">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-[2px] bg-[#b9cfe4]/70" />
            Cloud
          </span>
          <span className="flex items-center gap-1">
            <span className="text-amber">↗</span>
            Wind
          </span>
        </span>
      </header>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block w-full"
        role="img"
        aria-label={describeWeather(sky)}
      >
        <Air ground={profile.ground} />
        <Axis profile={profile} />
        <Ground y={pageY(profile.ground)} />

        {profile.clouds.length === 0 ? (
          <text
            x={(CLOUD_X0 + CLOUD_X1) / 2}
            y={pageY(profile.ground) - 24}
            textAnchor="middle"
            className="fill-osd-faint"
            fontSize={9}
            letterSpacing="0.14em"
          >
            SKY CLEAR
          </text>
        ) : (
          profile.clouds.map((band) => <Deck key={band.index} band={band} />)
        )}

        <WindLane profile={profile} />
      </svg>

      <footer className="space-y-1 border-t border-hairline px-3 py-2 text-2xs leading-relaxed text-osd-faint">
        <p>
          Zero is the ground under the launch point
          {terrainHeight === null
            ? ""
            : `, ${Math.round(terrainHeight)} m above the sea`}
          . A deck under that line is one you take off above and look down on.
        </p>
      </footer>
    </section>
  );
}

// --- Parts ------------------------------------------------------------------

/** The air itself: darker with height, so the axis reads as a sky. */
function Air({ ground }: { ground: number }) {
  return (
    <>
      <rect
        x={CLOUD_X0}
        y={TOP}
        width={CLOUD_X1 - CLOUD_X0}
        height={PLOT_HEIGHT}
        fill="#070c13"
      />
      <rect
        x={CLOUD_X0}
        y={TOP}
        width={CLOUD_X1 - CLOUD_X0}
        height={Math.max(pageY(ground) - TOP, 0)}
        fill="#0d1621"
      />
    </>
  );
}

function Axis({ profile }: { profile: ReturnType<typeof buildSkyProfile> }) {
  return (
    <g>
      <line
        x1={AXIS_X}
        y1={TOP}
        x2={AXIS_X}
        y2={TOP + PLOT_HEIGHT}
        stroke="#2f3d4d"
        strokeWidth={1}
      />
      {profile.ticks.map((tick) => {
        const y = pageY(tick.y);
        return (
          <g key={tick.altitude}>
            <line
              x1={AXIS_X - 3}
              y1={y}
              x2={CLOUD_X1}
              y2={y}
              stroke={tick.altitude === 0 ? "#2f3d4d" : "#1e2733"}
              strokeWidth={1}
              strokeDasharray={tick.altitude === 0 ? undefined : "1 4"}
            />
            <text
              x={GUTTER_X}
              y={y + 3}
              textAnchor="end"
              className="fill-osd-faint"
              fontSize={8}
            >
              {tick.altitude}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * The ground under the launch point, with the wing sitting on it.
 *
 * A massif rather than a floor. The reason a cloud base is allowed to be
 * negative is that the flight starts on top of something, so the ground is
 * drawn as the summit it is: the air to either side of it, and any deck down
 * in it, stays visible below the launch line.
 */
function Ground({ y }: { y: number }) {
  const bottom = TOP + PLOT_HEIGHT;
  const summit = AXIS_X + 62;
  const massif =
    `M${summit - 34},${y + 3} L${summit - 14},${y - 1} L${summit + 4},${y + 2} ` +
    `L${summit + 30},${y + 6} L${summit + 46},${y + 22} L${summit + 60},${bottom} ` +
    `L${summit - 52},${bottom} L${summit - 44},${y + 18} Z`;
  return (
    <g>
      <path d={massif} fill="#141c26" stroke="#2f3d4d" strokeWidth={1} />
      <line
        x1={AXIS_X}
        y1={y}
        x2={CLOUD_X1}
        y2={y}
        stroke="#7ce07c"
        strokeWidth={1}
        strokeOpacity={0.45}
        strokeDasharray="5 4"
      />
      {/* The wing, on the ground it launches from. */}
      <path
        d={`M${summit},${y - 5} l7,3 -7,3 -7,-3 z`}
        fill="#7ce07c"
        fillOpacity={0.85}
      />
      <text
        x={CLOUD_X1 - 3}
        y={y - 5}
        textAnchor="end"
        className="fill-lime"
        fontSize={7.5}
        letterSpacing="0.14em"
        opacity={0.75}
      >
        LAUNCH
      </text>
    </g>
  );
}

/**
 * One cloud deck.
 *
 * The top edge carries the genus: convective cloud is scalloped because it
 * piles up into lumps, a sheet is ruled flat because it does not, and cirrus
 * is drawn broken because it is ice you can see straight through.
 */
function Deck({ band }: { band: SkyProfileBand }) {
  const info = CLOUD_TYPE_INFO[band.layer.type];
  const colour = CLOUD_COLOUR[band.layer.type];
  const top = pageY(band.top);
  const bottom = pageY(band.bottom);
  const height = Math.max(bottom - top, 3);
  const lumpy = info.convection >= 0.45;
  const roomInside = height >= 22;

  return (
    <g>
      <rect
        x={CLOUD_X0}
        y={top}
        width={CLOUD_X1 - CLOUD_X0}
        height={height}
        fill={colour}
        fillOpacity={0.14 + 0.4 * band.coverage}
      />
      {lumpy ? (
        <path
          d={scallop(CLOUD_X0, CLOUD_X1, top)}
          fill={colour}
          fillOpacity={0.18 + 0.42 * band.coverage}
          stroke={colour}
          strokeOpacity={0.7}
          strokeWidth={1}
        />
      ) : (
        <line
          x1={CLOUD_X0}
          y1={top}
          x2={CLOUD_X1}
          y2={top}
          stroke={colour}
          strokeOpacity={0.75}
          strokeWidth={1}
          strokeDasharray={info.density < 0.4 ? "6 4" : undefined}
        />
      )}
      <line
        x1={CLOUD_X0}
        y1={bottom}
        x2={CLOUD_X1}
        y2={bottom}
        stroke={colour}
        strokeOpacity={0.85}
        strokeWidth={1}
      />

      <text
        x={CLOUD_X0 + 5}
        y={roomInside ? top + 12 : bottom + 9}
        className="fill-osd"
        fontSize={9}
        letterSpacing="0.1em"
      >
        {band.label}
      </text>
      <text
        x={CLOUD_X1 - 4}
        y={roomInside ? top + 12 : bottom + 9}
        textAnchor="end"
        className="fill-osd-dim"
        fontSize={8}
      >
        {oktasLabel(band.layer)} · {Math.round(band.baseAgl)} m
      </text>
    </g>
  );
}

/**
 * The wind, in its own lane and in its own language.
 *
 * One arrow per level, pointing the way the air is *going* — the report quotes
 * the direction it comes from, which is the one convention that catches
 * everybody out at least once, so the picture resolves it rather than
 * repeating it.
 */
function WindLane({ profile }: { profile: ReturnType<typeof buildSkyProfile> }) {
  return (
    <g>
      <line
        x1={DIVIDER_X}
        y1={TOP}
        x2={DIVIDER_X}
        y2={TOP + PLOT_HEIGHT}
        stroke="#1e2733"
        strokeWidth={1}
      />
      <line
        x1={WIND_X}
        y1={TOP}
        x2={WIND_X}
        y2={TOP + PLOT_HEIGHT}
        stroke="#8a6014"
        strokeWidth={1}
        strokeDasharray="2 5"
      />
      <text
        x={WIND_X - 8}
        y={TOP - 5}
        className="fill-amber"
        fontSize={7.5}
        letterSpacing="0.16em"
        opacity={0.8}
      >
        WIND
      </text>

      {profile.winds.map((wind) => {
        const y = pageY(wind.y);
        // The barb points downwind: a report's degrees are where it comes from.
        const towards = (wind.directionDeg + 180) % 360;
        const calm = wind.speed < 0.5;
        return (
          <g key={wind.index}>
            <line
              x1={WIND_X - 5}
              y1={y}
              x2={WIND_X + 5}
              y2={y}
              stroke="#8a6014"
              strokeWidth={1}
            />
            {calm ? (
              <circle
                cx={WIND_X}
                cy={y}
                r={3.5}
                fill="none"
                stroke="#ffb020"
                strokeOpacity={0.7}
                strokeWidth={1}
              />
            ) : (
              <g transform={`translate(${WIND_X} ${y}) rotate(${towards})`}>
                <path
                  d="M0,9 L0,-9 M0,-9 L-3.6,-3.6 M0,-9 L3.6,-3.6"
                  fill="none"
                  stroke="#ffb020"
                  strokeWidth={0.9 + 1.1 * wind.strength}
                  strokeLinecap="round"
                />
              </g>
            )}
            <text
              x={WIND_TEXT_X}
              y={y - 1}
              className="fill-osd-dim"
              fontSize={8}
            >
              {String(Math.round(wind.directionDeg)).padStart(3, "0")}°
            </text>
            <text
              x={WIND_TEXT_X}
              y={y + 8}
              className="fill-osd-faint"
              fontSize={8}
            >
              {Math.round(wind.speed * 3.6)} km/h
            </text>
          </g>
        );
      })}
    </g>
  );
}

// --- Drawing helpers --------------------------------------------------------

/** A run of bumps across the top of a convective deck. */
function scallop(x0: number, x1: number, y: number): string {
  const bumps = 7;
  const width = (x1 - x0) / bumps;
  let path = `M${x0},${y + 4}`;
  for (let i = 0; i < bumps; i += 1) {
    const start = x0 + i * width;
    const rise = i % 2 === 0 ? 7 : 4.5;
    path += ` Q${start + width / 2},${y - rise} ${start + width},${y + 4}`;
  }
  path += ` L${x1},${y + 5} L${x0},${y + 5} Z`;
  return path;
}
