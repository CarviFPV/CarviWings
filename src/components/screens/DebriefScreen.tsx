"use client";

/**
 * Mission debrief.
 *
 * Five outcomes share one screen: an intercept mission won or lost, a
 * formation flight graded, a race with a result board, and a free flight that
 * ended in a crash. What changes is the headline and which numbers lead —
 * everything else is the same flight record.
 */

import { useGameStore } from "@/state/gameStore";
import type { FlightStatistics } from "@/sim/flight/telemetry";
import { MS_TO_KMH, formatDuration } from "@/sim/flight/telemetry";
import type { MissionStatus, RacerStanding } from "@/sim/mission";
import {
  MISSION_OUTCOME,
  formatRaceTime,
  formatStreamerLength,
  formationGrade,
  ordinal,
  racePlacing,
} from "@/sim/mission";
import { PrimaryButton } from "@/components/ui/Primitives";

/**
 * One racer's clock, as the board reads it when the race ends.
 *
 * Everybody on the course is timed the same way — own start gate to own finish
 * gate — so everybody has a time to show, not only the ones who got home. The
 * race is over for the pilot the moment they cross the line, and a rival still
 * out there stops with whatever was on its clock at that moment: that is not a
 * finishing time and is not dressed up as one, but it is what says how the two
 * runs compared, which is the only thing a result board is for.
 */
function racerTime(entry: RacerStanding): string {
  return entry.started ? formatRaceTime(entry.elapsed) : "not started";
}

function StatRow({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-hairline py-2.5">
      <span className="text-2xs uppercase tracking-[0.16em] text-osd-dim">
        {label}
      </span>
      <span
        className={`tabular-nums text-sm ${emphasis ? "text-lime" : "text-osd"}`}
      >
        {value}
      </span>
    </div>
  );
}

export function DebriefScreen({
  statistics,
  status,
  reason,
}: {
  statistics: FlightStatistics;
  status: MissionStatus;
  reason: string;
}) {
  const restart = useGameStore((state) => state.restartMission);
  const exitToMenu = useGameStore((state) => state.exitToMenu);

  const complete = status.outcome === MISSION_OUTCOME.Complete;
  const formation = status.formation;
  const race = status.race;
  const festival = status.festival;
  // Only at a streamer event, and only once somebody has been entered for it:
  // a fly-in has no board and must not be shown an empty one.
  const streamerBoard = festival?.streamer ?? null;
  const flewIntercept =
    !formation &&
    !race &&
    !festival &&
    status.enemiesDestroyed + status.enemiesRemaining > 0;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center overflow-y-auto bg-void">
      <div className="w-full max-w-md px-8 py-12">
        <p
          className={`text-2xs uppercase tracking-[0.4em] ${
            complete ? "text-lime" : "text-danger"
          }`}
        >
          {flewIntercept || formation || race || festival
            ? "Mission"
            : "Flight ended"}
        </p>
        <h2 className="mt-2 mb-2 text-3xl font-light tracking-[0.06em]">
          {formation
            ? formationGrade(formation.score).toUpperCase()
            : race
              ? race.finished
                ? race.racerCount > 1
                  ? `${racePlacing(race.position).toUpperCase()} PLACE`
                  : "COURSE FLOWN"
                : "OUT OF THE RACE"
              : festival
                ? streamerBoard
                  ? streamerBoard.player?.position === 1
                    ? "STREAMER CUT WON"
                    : `${ordinal(streamerBoard.player?.position ?? 0).toUpperCase()} ON PAPER`
                  : complete
                    ? "SLOT FLOWN"
                    : "DAY OVER"
                : complete
                  ? "MISSION COMPLETE"
                  : flewIntercept
                    ? "MISSION FAILED"
                    : "AIRCRAFT DESTROYED"}
        </h2>
        <p className="mb-8 text-sm text-osd-dim">{reason}</p>

        <div className="mb-8">
          {formation ? (
            <>
              <StatRow
                label="Time in station"
                value={`${Math.round(formation.score * 100)}%`}
                emphasis={complete}
              />
              <StatRow
                label="Held for"
                value={formatDuration(formation.timeInStation)}
              />
              <StatRow
                label="Longest unbroken"
                value={formatDuration(formation.bestStreak)}
              />
              <StatRow
                label="Routine flown"
                value={`${formatDuration(formation.elapsed)} of ${formatDuration(
                  formation.total,
                )}`}
              />
              {/* Only worth a line when it happened; a nought here reads as a
                  scoring category rather than as a clean flight. */}
              {formation.midairs > 0 ? (
                <StatRow label="Mid-airs" value={String(formation.midairs)} />
              ) : null}
            </>
          ) : null}
          {race ? (
            <>
              <StatRow
                label="Race time"
                value={
                  race.finished ? formatRaceTime(race.elapsed) : "Did not finish"
                }
                emphasis={race.finished}
              />
              <StatRow
                label="Gates flown"
                value={`${race.gatesPassed} of ${race.gateCount}`}
              />
              {race.racerCount > 1 ? (
                <StatRow
                  label="Finishing position"
                  value={`${racePlacing(race.position)} of ${race.racerCount}`}
                  emphasis={race.position === 1}
                />
              ) : null}
            </>
          ) : null}
          {festival ? (
            <>
              {streamerBoard?.player ? (
                <>
                  <StatRow
                    label="Streamer cut"
                    value={formatStreamerLength(streamerBoard.player.cut)}
                    emphasis={streamerBoard.player.position === 1}
                  />
                  <StatRow
                    label="Passes that took paper"
                    value={String(streamerBoard.player.cuts)}
                  />
                  <StatRow
                    label="Your own paper lost"
                    value={formatStreamerLength(streamerBoard.player.lost)}
                  />
                  <StatRow
                    label="Left on your tail"
                    value={formatStreamerLength(streamerBoard.player.remaining)}
                  />
                  <StatRow
                    label="Place on the board"
                    value={`${ordinal(streamerBoard.player.position)} of ${
                      streamerBoard.standings.length
                    }`}
                    emphasis={streamerBoard.player.position === 1}
                  />
                </>
              ) : null}
              <StatRow
                label="Waves flown"
                value={String(festival.wavesFlown)}
                emphasis={complete && !streamerBoard}
              />
              <StatRow
                label="Time on the field"
                value={formatDuration(festival.elapsed)}
              />
              <StatRow
                label="Mid-airs on the field"
                value={String(festival.midairs)}
              />
              <StatRow
                label="Yours"
                value={String(festival.playerMidairs)}
              />
              <StatRow
                label="Still flying at the end"
                value={`${festival.flying} of ${festival.total}`}
              />
            </>
          ) : null}
          {flewIntercept ? (
            <>
              <StatRow
                label="Enemies destroyed"
                value={String(status.enemiesDestroyed)}
                emphasis={complete}
              />
              {!complete ? (
                <StatRow
                  label="Enemies remaining"
                  value={String(status.enemiesRemaining)}
                />
              ) : null}
              <StatRow
                label="Airframes expended"
                value={String(statistics.crashes + statistics.collisions)}
              />
            </>
          ) : null}
          <StatRow label="Flight time" value={formatDuration(statistics.flightTime)} />
          <StatRow
            label="Distance flown"
            value={`${(statistics.distanceFlown / 1000).toFixed(2)} km`}
          />
          <StatRow
            label="Maximum altitude"
            value={`${statistics.maxAltitude.toFixed(0)} m`}
          />
          <StatRow
            label="Maximum height AGL"
            value={`${statistics.maxAltitudeAgl.toFixed(0)} m`}
          />
          <StatRow
            label="Maximum speed"
            value={`${(statistics.maxAirspeed * MS_TO_KMH).toFixed(0)} km/h`}
          />
          <StatRow
            label="Average speed"
            value={`${(statistics.averageAirspeed * MS_TO_KMH).toFixed(0)} km/h`}
          />
          <StatRow label="Collisions" value={String(statistics.collisions)} />
          <StatRow label="Crashes" value={String(statistics.crashes)} />
          {statistics.landings > 0 ? (
            <StatRow label="Landings" value={String(statistics.landings)} />
          ) : null}
        </div>

        {race && race.racerCount > 1 ? (
          <div className="mb-8">
            <p className="mb-2 text-2xs uppercase tracking-[0.28em] text-osd-dim">
              Result
            </p>
            {race.standings.map((entry) => (
              <div
                key={entry.id}
                className={`flex items-baseline justify-between border-b border-hairline py-2 text-sm ${
                  entry.isPlayer ? "text-cyan" : "text-osd-dim"
                }`}
              >
                <span className="flex items-baseline gap-3">
                  <span className="w-6 tabular-nums text-2xs text-osd-faint">
                    {entry.position}
                  </span>
                  <span className="tracking-[0.12em]">{entry.label}</span>
                </span>
                <span className="flex items-baseline gap-3">
                  {entry.started && !entry.finished ? (
                    <span className="text-2xs text-osd-faint">
                      gate {entry.gatesPassed}/{race.gateCount}
                    </span>
                  ) : null}
                  <span className="tabular-nums">{racerTime(entry)}</span>
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {streamerBoard && streamerBoard.standings.length > 1 ? (
          <div className="mb-8">
            <p className="mb-2 text-2xs uppercase tracking-[0.28em] text-osd-dim">
              Paper cut
            </p>
            {streamerBoard.standings.map((entry) => (
              <div
                key={entry.competitorId}
                className={`flex items-baseline justify-between border-b border-hairline py-2 text-sm ${
                  entry.isPlayer ? "text-cyan" : "text-osd-dim"
                }`}
              >
                <span className="flex items-baseline gap-3">
                  <span className="w-6 tabular-nums text-2xs text-osd-faint">
                    {entry.position}
                  </span>
                  {/* The colour is how the field is told apart in the air, so
                      it is how the board reads too. */}
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="tracking-[0.12em]">{entry.label}</span>
                </span>
                <span className="flex items-baseline gap-3">
                  <span className="text-2xs text-osd-faint">
                    {formatStreamerLength(entry.remaining)} left
                  </span>
                  <span className="tabular-nums">
                    {formatStreamerLength(entry.cut)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="space-y-2">
          <PrimaryButton tone="accent" onClick={() => restart()}>
            {race
              ? "Race again"
              : festival
                ? "Another slot"
                : complete
                  ? "Fly again"
                  : "Restart mission"}
          </PrimaryButton>
          <PrimaryButton onClick={() => exitToMenu()}>Main menu</PrimaryButton>
        </div>
      </div>
    </div>
  );
}
