"use client";

/**
 * The roster, and the flying pilot's logbook.
 *
 * Two screens in one, because they are the same screen at different times: on
 * a first run there is nobody to fly as, so all it offers is the form that
 * creates somebody. Once a pilot exists it becomes the place to switch between
 * them and to read what the one flying has done.
 *
 * Everything below the roster is derived from the logbook every time it is
 * rendered rather than stored — a career that disagreed with the flights it
 * was built from would be worse than no career at all.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { SCREEN, useGameStore } from "@/state/gameStore";
import {
  useActiveLog,
  usePlayerStore,
} from "@/state/playerStore";
import type {
  FlightRecord,
  PilotBackup,
  PlayerProfile,
  Roster,
} from "@/sim/player";
import {
  MAX_CALLSIGN_LENGTH,
  MAX_PLAYERS,
  backupFileName,
  callsignRejection,
  personalBests,
  rosterFull,
  summariseCareer,
} from "@/sim/player";
import { MS_TO_KMH, formatDuration } from "@/sim/flight/telemetry";
import {
  MISSION_MODE,
  MISSION_MODE_INFO,
  formatRaceTime,
  formationGrade,
  isOpenFlight,
  racePlacing,
} from "@/sim/mission";
import {
  MenuColumns,
  PrimaryButton,
  SectionLabel,
} from "@/components/ui/Primitives";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Career time, which runs to hours and is not read off a stopwatch. */
function formatHours(seconds: number): string {
  if (seconds < MINUTE) return `${Math.round(seconds)} s`;
  if (seconds < HOUR) return `${Math.round(seconds / MINUTE)} min`;
  const hours = Math.floor(seconds / HOUR);
  const minutes = Math.round((seconds - hours * HOUR) / MINUTE);
  return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
}

function formatDistance(metres: number): string {
  const km = metres / 1000;
  return km >= 100 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

/**
 * When something happened, near enough for a roster row.
 *
 * `now` is read once when the screen opens rather than during a render, so
 * every row on the list is measured from the same instant. Until it has been,
 * the column is empty: a wrong date corrected a frame later is worse than a
 * date that arrives a frame late.
 */
function whenText(then: number | null, now: number): string {
  if (now === 0) return "";
  if (then === null || then <= 0) return "Never flown";
  const days = Math.floor((now - then) / DAY_MS);
  if (days <= 0) return "Flew today";
  if (days === 1) return "Flew yesterday";
  if (days < 30) return `Flew ${days} days ago`;
  return `Last flew ${new Date(then).toLocaleDateString()}`;
}

/** What a logged flight was, in the words the mission screens use. */
function recordHeadline(record: FlightRecord): string {
  const label = MISSION_MODE_INFO[record.mode].label;
  if (record.mode === MISSION_MODE.Race) {
    if (record.raceTime === null) return `${label} · did not finish`;
    const place =
      record.racePosition !== null && (record.raceFieldSize ?? 1) > 1
        ? ` · ${racePlacing(record.racePosition)}`
        : "";
    return `${label} · ${formatRaceTime(record.raceTime)}${place}`;
  }
  if (record.mode === MISSION_MODE.Formation && record.formationScore !== null) {
    return `${label} · ${formationGrade(record.formationScore)}`;
  }
  if (record.mode === MISSION_MODE.Festival && record.festivalWaves !== null) {
    const waves = record.festivalWaves;
    return `${label} · ${waves} wave${waves === 1 ? "" : "s"}`;
  }
  if (record.enemiesDestroyed > 0) {
    return `${label} · ${record.enemiesDestroyed} down`;
  }
  return label;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-hairline px-3 py-2">
      <p className="text-2xs uppercase tracking-[0.14em] text-osd-dim">{label}</p>
      <p className="mt-1 text-sm tabular-nums text-osd">{value}</p>
    </div>
  );
}

/** The form that creates a pilot, on its own during a first run. */
function CallsignForm({
  label,
  initial = "",
  onSubmit,
  onCancel,
  validate,
}: {
  label: string;
  initial?: string;
  onSubmit: (callsign: string) => void;
  onCancel?: () => void;
  validate: (callsign: string) => string | null;
}) {
  const [callsign, setCallsign] = useState(initial);
  const [touched, setTouched] = useState(false);

  const rejection = validate(callsign);
  const showRejection = touched && rejection !== null;

  // Typing a name and pressing return is the whole interaction, so the key
  // does what the button does rather than needing the button to be found.
  const submit = (): void => {
    setTouched(true);
    if (rejection === null) onSubmit(callsign);
  };

  return (
    <div>
      <label className="block">
        <span className="mb-1 block text-2xs uppercase tracking-[0.14em] text-osd-dim">
          {label}
        </span>
        <input
          autoFocus
          value={callsign}
          maxLength={MAX_CALLSIGN_LENGTH}
          onChange={(event) => setCallsign(event.target.value)}
          onBlur={() => setTouched(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape" && onCancel) {
              event.preventDefault();
              onCancel();
            }
          }}
          placeholder="Callsign"
          className={`w-full border bg-void px-3 py-2 text-sm uppercase tracking-[0.12em] text-osd outline-none transition-colors focus:border-cyan ${
            showRejection ? "border-danger" : "border-hairline"
          }`}
        />
      </label>
      <p
        className={`mt-2 min-h-[1rem] text-2xs ${
          showRejection ? "text-danger" : "text-osd-faint"
        }`}
      >
        {showRejection ? rejection : `Up to ${MAX_CALLSIGN_LENGTH} characters.`}
      </p>
      <div className="mt-2 flex gap-2">
        <PrimaryButton tone="accent" onClick={submit}>
          <span className="block w-full text-center">Save</span>
        </PrimaryButton>
        {onCancel ? (
          <PrimaryButton onClick={onCancel}>
            <span className="block w-full text-center">Cancel</span>
          </PrimaryButton>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Hands a backup to the browser's downloads.
 *
 * An anchor with a `download` on it rather than anything cleverer: it is the
 * one way to write a file that works without a server to fetch it from, which
 * is the whole point of a simulator that has no server behind it.
 */
function saveBackupFile(backup: PilotBackup): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = backupFileName(backup.callsign, backup.exportedAt);
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Handed back after the click, not before: a browser that is still starting
  // the download when the URL is revoked saves nothing at all.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface TransferMessage {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * Saving a pilot to a file, and reading one back.
 *
 * The answer to the one thing a browser cannot promise: the settings, the key
 * layout, the calibration and the logbook are all kept in this browser, and
 * clearing this browser's data clears them. A backup is a file the pilot holds
 * instead, so the same pilot can come back after a clear-out, on a different
 * browser, or on a different machine entirely.
 *
 * Restoring never replaces anybody. It adds the pilot in the file to the
 * roster and flies as them, so a file restored into the browser it came from
 * costs a roster row rather than the logbook it was taken from.
 */
function PilotTransfer({ backupOf }: { backupOf: PlayerProfile | null }) {
  const backupPilot = usePlayerStore((state) => state.backupPilot);
  const restorePilot = usePlayerStore((state) => state.restorePilot);
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<TransferMessage | null>(null);

  const save = (): void => {
    if (!backupOf) return;
    const backup = backupPilot(backupOf.id);
    if (!backup) {
      setMessage({ ok: false, text: "There is nothing to back up yet." });
      return;
    }
    try {
      saveBackupFile(backup);
      setMessage({
        ok: true,
        text: `Saved ${backupFileName(
          backup.callsign,
          backup.exportedAt,
        )} — keep it somewhere clearing this browser cannot reach.`,
      });
    } catch {
      setMessage({ ok: false, text: "This browser would not save the file." });
    }
  };

  const restore = async (file: File): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text()) as unknown;
    } catch {
      setMessage({ ok: false, text: "That file could not be read as a backup." });
      return;
    }
    const result = restorePilot(parsed);
    setMessage(
      result.ok
        ? {
            ok: true,
            text:
              `${result.profile.callsign} is back, with their settings, ` +
              "key layout, controller calibration and logbook. You are " +
              "flying as them now.",
          }
        : { ok: false, text: result.reason },
    );
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {backupOf ? (
          <PrimaryButton onClick={save}>
            <span className="block w-full text-center">
              Back up {backupOf.callsign}
            </span>
          </PrimaryButton>
        ) : null}
        <PrimaryButton onClick={() => fileInput.current?.click()}>
          <span className="block w-full text-center">Restore from a file</span>
        </PrimaryButton>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared straight away, so picking the same file twice is two
          // restores rather than one and then nothing.
          event.target.value = "";
          if (file) void restore(file);
        }}
      />
      {message ? (
        <p
          className={`mt-2 text-2xs leading-relaxed ${
            message.ok ? "text-lime" : "text-danger"
          }`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

export function PilotScreen() {
  const goto = useGameStore((state) => state.goto);
  const roster = usePlayerStore((state) => state.roster);
  const createPilot = usePlayerStore((state) => state.createPilot);
  const selectPilot = usePlayerStore((state) => state.selectPilot);
  const renamePilot = usePlayerStore((state) => state.renamePilot);
  const deletePilot = usePlayerStore((state) => state.deletePilot);
  const log = useActiveLog();

  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const firstRun = roster.players.length === 0;
  const active = roster.activeId;
  const activeProfile =
    roster.players.find((player) => player.id === active) ?? null;

  // The relative dates on the roster are read once per visit rather than per
  // render, so a list cannot show two rows measured from different instants.
  const [now, setNow] = useState(0);
  useEffect(() => setNow(Date.now()), []);

  const career = useMemo(() => summariseCareer(log), [log]);
  const bests = useMemo(() => personalBests(log), [log]);

  const closeForms = (): void => {
    setAdding(false);
    setRenaming(null);
    setDeleting(null);
  };

  if (firstRun) {
    return (
      <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-void">
        <div className="w-full max-w-sm px-8 py-12">
          <p className="text-2xs uppercase tracking-[0.4em] text-accent">
            Before you fly
          </p>
          <h1 className="mt-2 mb-3 text-3xl font-light tracking-[0.06em]">
            WHO IS FLYING?
          </h1>
          <p className="mb-6 text-xs leading-relaxed text-osd-dim">
            Your settings, key layout, controller calibration and logbook are
            saved against a callsign, so more than one person can fly here
            without flying each other&rsquo;s aircraft. You can add more pilots
            later.
          </p>
          <CallsignForm
            label="Callsign"
            validate={(callsign) => callsignRejection(callsign, roster)}
            onSubmit={(callsign) => {
              createPilot(callsign);
              closeForms();
            }}
          />
          <p className="mt-6 text-2xs leading-relaxed text-osd-faint">
            Kept in this browser. Nothing is sent anywhere, and there is no
            account and no password to lose — so back the pilot up to a file
            once you have one, and clearing this browser costs you nothing.
          </p>

          <div className="mt-6 border-t border-hairline pt-5">
            <SectionLabel>Flown here before?</SectionLabel>
            <p className="mb-3 text-2xs leading-relaxed text-osd-dim">
              If you have a backup file — from this browser before it was
              cleared, or from another machine — restore it instead of starting
              again. Settings, key layout, calibration and logbook all come
              back with it.
            </p>
            <PilotTransfer backupOf={null} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-void">
      <div className="mx-auto w-full max-w-[76rem] px-8 py-12">
        <header className="mb-10 flex items-end justify-between border-b border-hairline pb-5">
          <div>
            <p className="text-2xs uppercase tracking-[0.4em] text-accent">
              Roster
            </p>
            <h1 className="mt-2 text-3xl font-light tracking-[0.06em]">PILOTS</h1>
          </div>
          <button
            type="button"
            onClick={() => goto(SCREEN.Menu)}
            className="text-2xs uppercase tracking-[0.18em] text-osd-dim transition-colors hover:text-osd"
          >
            &larr; Main menu
          </button>
        </header>

        <MenuColumns minWidth="26rem">
          <section>
            <SectionLabel>Who is flying</SectionLabel>
            <div className="space-y-1.5">
              {roster.players.map((player) => (
                <PilotRow
                  key={player.id}
                  player={player}
                  active={player.id === active}
                  now={now}
                  renaming={renaming === player.id}
                  deleting={deleting === player.id}
                  roster={roster}
                  onSelect={() => {
                    closeForms();
                    selectPilot(player.id);
                  }}
                  onRename={(callsign) => {
                    renamePilot(player.id, callsign);
                    closeForms();
                  }}
                  onBeginRename={() => {
                    closeForms();
                    setRenaming(player.id);
                  }}
                  onBeginDelete={() => {
                    closeForms();
                    setDeleting(player.id);
                  }}
                  onConfirmDelete={() => {
                    deletePilot(player.id);
                    closeForms();
                  }}
                  onCancel={closeForms}
                />
              ))}
            </div>

            {adding ? (
              <div className="mt-3 border border-hairline p-4">
                <CallsignForm
                  label="New pilot"
                  validate={(callsign) => callsignRejection(callsign, roster)}
                  onSubmit={(callsign) => {
                    createPilot(callsign);
                    closeForms();
                  }}
                  onCancel={closeForms}
                />
              </div>
            ) : (
              <div className="mt-3">
                <PrimaryButton
                  disabled={rosterFull(roster)}
                  onClick={() => {
                    closeForms();
                    setAdding(true);
                  }}
                >
                  {rosterFull(roster)
                    ? `Roster full — ${MAX_PLAYERS} pilots`
                    : "Add a pilot"}
                </PrimaryButton>
              </div>
            )}
            <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
              Switching pilot loads that pilot&rsquo;s settings, key layout and
              controller calibration. Deleting one deletes all of it, including
              their logbook.
            </p>

            <div className="mt-8">
              <SectionLabel>Backup</SectionLabel>
              <p className="mb-3 text-2xs leading-relaxed text-osd-dim">
                A pilot lives in this browser, so clearing this site&rsquo;s
                data takes them with it. Saving one writes a file holding their
                settings, key layout, controller calibration and every flight
                in their logbook — keep it, and restore it here on any browser
                or any machine. Restoring adds the pilot in the file rather
                than writing over anybody already on the roster.
              </p>
              <PilotTransfer backupOf={activeProfile} />
            </div>
          </section>

          <section>
            <SectionLabel>Logbook</SectionLabel>
            {career.flights === 0 ? (
              <p className="text-xs leading-relaxed text-osd-dim">
                Nothing flown yet. Every flight that reaches a debrief is
                written down here.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  <Stat label="Flights" value={String(career.flights)} />
                  <Stat
                    label="Missions flown"
                    value={`${career.missionsComplete}/${career.missionsFlown}`}
                  />
                  <Stat
                    label="In the air"
                    value={formatHours(career.flightTime)}
                  />
                  <Stat
                    label="Distance"
                    value={formatDistance(career.distanceFlown)}
                  />
                  <Stat
                    label="Contacts down"
                    value={String(career.enemiesDestroyed)}
                  />
                  <Stat
                    label="Top speed"
                    value={`${Math.round(career.topSpeed * MS_TO_KMH)} km/h`}
                  />
                  <Stat
                    label="Highest AGL"
                    value={`${Math.round(career.highestAgl)} m`}
                  />
                  <Stat
                    label="Longest flight"
                    value={formatDuration(career.longestFlight)}
                  />
                  <Stat
                    label="Crashes"
                    value={`${career.crashes} / ${career.landings} down safe`}
                  />
                </div>

                {bests.races.length > 0 ||
                bests.formationScore !== null ||
                bests.festivalWaves !== null ? (
                  <div className="mt-6">
                    <SectionLabel>Personal bests</SectionLabel>
                    {bests.races.map((best) => (
                      <BestRow
                        key={best.locationName}
                        label={`Race · ${best.locationName}`}
                        value={formatRaceTime(best.time)}
                      />
                    ))}
                    {bests.formationScore !== null ? (
                      <BestRow
                        label="Formation"
                        value={`${formationGrade(bests.formationScore)} · ${Math.round(
                          bests.formationScore * 100,
                        )}%`}
                      />
                    ) : null}
                    {bests.festivalWaves !== null ? (
                      <BestRow
                        label="Festival"
                        value={`${bests.festivalWaves} wave${
                          bests.festivalWaves === 1 ? "" : "s"
                        }`}
                      />
                    ) : null}
                    {bests.enemiesInOneFlight !== null ? (
                      <BestRow
                        label="Most in one flight"
                        value={`${bests.enemiesInOneFlight} down`}
                      />
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-6">
                  <SectionLabel>Recent flights</SectionLabel>
                  {log.slice(0, 8).map((record, index) => (
                    <div
                      key={`${record.flownAt}-${index}`}
                      className="flex items-baseline justify-between border-b border-hairline py-2"
                    >
                      <span className="min-w-0 pr-3">
                        <span className="block truncate text-xs text-osd">
                          {recordHeadline(record)}
                        </span>
                        <span className="block truncate text-2xs text-osd-faint">
                          {record.locationName}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-xs tabular-nums text-osd-dim">
                          {formatDuration(record.flightTime)}
                        </span>
                        <span
                          className={`block text-2xs uppercase tracking-[0.14em] ${
                            record.complete ? "text-lime" : "text-osd-faint"
                          }`}
                        >
                          {isOpenFlight(record.mode)
                            ? formatDistance(record.distanceFlown)
                            : record.complete
                              ? "Complete"
                              : "Failed"}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        </MenuColumns>

        <p className="mt-8 text-2xs leading-relaxed text-osd-faint">
          Pilots are stored in this browser only — there is no account, no
          server and nothing to sign in to. Clearing this site&rsquo;s data
          clears the roster with it, so a pilot you want to keep is a pilot you
          have a backup file for.
        </p>
      </div>
    </div>
  );
}

function BestRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-hairline py-2">
      <span className="text-2xs uppercase tracking-[0.16em] text-osd-dim">
        {label}
      </span>
      <span className="text-sm tabular-nums text-lime">{value}</span>
    </div>
  );
}

function PilotRow({
  player,
  active,
  now,
  renaming,
  deleting,
  roster,
  onSelect,
  onRename,
  onBeginRename,
  onBeginDelete,
  onConfirmDelete,
  onCancel,
}: {
  player: PlayerProfile;
  active: boolean;
  now: number;
  renaming: boolean;
  deleting: boolean;
  roster: Roster;
  onSelect: () => void;
  onRename: (callsign: string) => void;
  onBeginRename: () => void;
  onBeginDelete: () => void;
  onConfirmDelete: () => void;
  onCancel: () => void;
}) {
  if (renaming) {
    return (
      <div className="border border-cyan/50 p-4">
        <CallsignForm
          label={`Rename ${player.callsign}`}
          initial={player.callsign}
          validate={(callsign) => callsignRejection(callsign, roster, player.id)}
          onSubmit={onRename}
          onCancel={onCancel}
        />
      </div>
    );
  }

  if (deleting) {
    return (
      <div className="border border-danger/50 p-4">
        <p className="text-xs leading-relaxed text-osd">
          Delete {player.callsign}, their settings and their logbook? This
          cannot be undone.
        </p>
        <div className="mt-3 flex gap-2">
          <PrimaryButton tone="danger" onClick={onConfirmDelete}>
            <span className="block w-full text-center">Delete</span>
          </PrimaryButton>
          <PrimaryButton onClick={onCancel}>
            <span className="block w-full text-center">Keep</span>
          </PrimaryButton>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`border ${
        active ? "border-cyan/60 bg-cyan/5" : "border-hairline"
      }`}
    >
      <button
        type="button"
        onClick={active ? undefined : onSelect}
        className={`flex w-full items-baseline justify-between px-4 py-3 text-left ${
          active ? "cursor-default" : "transition-colors hover:bg-panel-raised"
        }`}
      >
        <span
          className={`text-sm uppercase tracking-[0.18em] ${
            active ? "text-cyan" : "text-osd"
          }`}
        >
          {player.callsign}
        </span>
        <span className="text-2xs uppercase tracking-[0.14em] text-osd-faint">
          {active ? "Flying" : whenText(player.lastFlownAt, now)}
        </span>
      </button>
      {active ? (
        <div className="flex gap-4 border-t border-hairline px-4 py-2">
          <button
            type="button"
            onClick={onBeginRename}
            className="text-2xs uppercase tracking-[0.16em] text-osd-dim transition-colors hover:text-osd"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={onBeginDelete}
            className="text-2xs uppercase tracking-[0.16em] text-osd-dim transition-colors hover:text-danger"
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}
