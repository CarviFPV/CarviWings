"use client";

import type { DebugSnapshot } from "@/components/flight/useTelemetry";
import type { FlightTelemetry } from "@/sim/flight/telemetry";
import { describeIonToken } from "@/lib/cesium/ionToken";
import { describeGoogleMapsKey } from "@/lib/cesium/googleKey";
import { PHYSICS_TIMESTEP } from "@/sim/flight/physics";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-6">
      <span className="text-osd-faint">{label}</span>
      <span className="tabular-nums text-osd">{value}</span>
    </div>
  );
}

export function DebugOverlay({
  debug,
  telemetry,
}: {
  debug: DebugSnapshot;
  telemetry: FlightTelemetry;
}) {
  return (
    <div className="pointer-events-none absolute right-4 top-4 z-20 w-72 border border-hairline bg-panel/92 p-3 text-2xs backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between border-b border-hairline pb-1.5">
        <span className="tracking-[0.2em] text-cyan">DEBUG · F3</span>
        <span className="text-osd-faint">{debug.status}</span>
      </div>

      <div className="space-y-0.5">
        <Row label="FPS" value={debug.fps.toFixed(1)} />
        <Row label="Frame" value={`${debug.frameMs.toFixed(1)} ms`} />
        <Row label="Sim rate" value={`${Math.round(1 / PHYSICS_TIMESTEP)} Hz`} />
        <Row label="Camera" value={debug.cameraMode} />
        <Row
          label="Input"
          value={
            debug.controllerName
              ? `${debug.inputDevice.toLowerCase()} (pad)`
              : debug.inputDevice.toLowerCase()
          }
        />
      </div>

      <div className="my-2 h-px bg-hairline" />
      <div className="space-y-0.5">
        <Row label="Latitude" value={telemetry.latitude.toFixed(6)} />
        <Row label="Longitude" value={telemetry.longitude.toFixed(6)} />
        <Row label="Altitude MSL" value={`${telemetry.altitude.toFixed(1)} m`} />
        <Row label="Altitude AGL" value={`${telemetry.altitudeAgl.toFixed(1)} m`} />
        <Row label="Terrain" value={`${telemetry.terrainHeight.toFixed(1)} m`} />
      </div>

      <div className="my-2 h-px bg-hairline" />
      <div className="space-y-0.5">
        <Row label="Airspeed" value={`${telemetry.airspeed.toFixed(2)} m/s`} />
        <Row label="Ground speed" value={`${telemetry.groundSpeed.toFixed(2)} m/s`} />
        <Row label="Vertical" value={`${telemetry.verticalSpeed.toFixed(2)} m/s`} />
        <Row label="Throttle" value={telemetry.throttle.toFixed(3)} />
        <Row label="AoA" value={`${debug.angleOfAttack.toFixed(2)}°`} />
        <Row label="Sideslip" value={`${debug.sideslip.toFixed(2)}°`} />
        <Row label="Load factor" value={`${debug.loadFactor.toFixed(2)} g`} />
      </div>

      <div className="my-2 h-px bg-hairline" />
      <div className="space-y-0.5">
        <Row label="Heading" value={`${telemetry.heading.toFixed(1)}°`} />
        <Row label="Pitch" value={`${telemetry.pitch.toFixed(1)}°`} />
        <Row label="Roll" value={`${telemetry.roll.toFixed(1)}°`} />
      </div>

      <div className="my-2 h-px bg-hairline" />
      <div className="space-y-0.5">
        <Row
          label="ENU origin"
          value={`${debug.originLatitude.toFixed(4)}, ${debug.originLongitude.toFixed(4)}`}
        />
        <Row label="Origin height" value={`${debug.originHeight.toFixed(1)} m`} />
        <Row
          label="Local ENU"
          value={`${debug.localX.toFixed(0)}, ${debug.localY.toFixed(0)}, ${debug.localZ.toFixed(0)}`}
        />
        <Row
          label="From origin"
          value={`${(telemetry.distanceFromOrigin / 1000).toFixed(2)} km`}
        />
      </div>

      <div className="my-2 h-px bg-hairline" />
      <div className="space-y-0.5">
        <Row label="Weather" value={debug.weather} />
        <Row label="Time" value={debug.timeOfDay} />
        <Row label="Clock" value={debug.clock} />
        <Row label="Sun" value={`${debug.sunElevation.toFixed(1)}°`} />
        <Row label="Daylight" value={debug.daylight.toFixed(2)} />
        <Row
          label="Wind"
          value={`${Math.round(telemetry.windDirection)
            .toString()
            .padStart(3, "0")}° / ${(telemetry.windSpeed * 3.6).toFixed(0)} km/h`}
        />
        <Row label="Sight range" value={`${(debug.sightRange / 1000).toFixed(2)} km`} />
        <Row
          label="Clouds"
          value={`${debug.cloudMode} · ${Math.round(debug.cloudCover * 100)}%${
            debug.cloudCount > 0 ? ` x${debug.cloudCount}` : ""
          }${debug.inCloud ? " (inside)" : ""}`}
        />
        <Row label="Decks" value={debug.cloudDecks} />
        {debug.stormy ? (
          <Row
            label="Lightning"
            value={
              debug.lightningFlash > 0.01
                ? `flash ${debug.lightningFlash.toFixed(2)}`
                : "cell active"
            }
          />
        ) : null}
        <Row label="Rain shader" value={debug.rainAvailable ? "ok" : "unavailable"} />
        <Row
          label="Video link"
          value={
            telemetry.videoLinkEnabled
              ? `${(telemetry.videoQuality * 100).toFixed(0)}% · ${(
                  telemetry.videoDistance / 1000
                ).toFixed(2)} / ${(telemetry.videoRange / 1000).toFixed(2)} km`
              : "unlimited"
          }
        />
        <Row
          label={telemetry.fuelled ? "Tank" : "Battery"}
          value={
            !telemetry.batteryEnabled
              ? "unlimited"
              : telemetry.fuelled
                ? `${(telemetry.batteryCharge * 100).toFixed(0)}% · ${telemetry.fuelLitres.toFixed(
                    2,
                  )} of ${telemetry.fuelCapacityLitres.toFixed(1)} L${
                    telemetry.batteryCut ? " · dry" : ""
                  }`
                : `${(telemetry.batteryCharge * 100).toFixed(0)}% · ${telemetry.batteryVoltage.toFixed(
                    2,
                  )} V (${telemetry.batteryCellVoltage.toFixed(2)} /cell)${
                    telemetry.batteryCut ? " · cut" : ""
                  }`
          }
        />
        <Row
          label={telemetry.fuelled ? "Burn" : "Pack draw"}
          value={
            !telemetry.batteryEnabled
              ? "-"
              : telemetry.fuelled
                ? `${telemetry.fuelBurnLitresPerHour.toFixed(2)} L/h`
                : `${telemetry.batteryCurrent.toFixed(1)} A · ${telemetry.batteryConsumedMah.toFixed(
                    0,
                  )} / ${telemetry.batteryCapacityMah} mAh`
          }
        />
      </div>

      <div className="my-2 h-px bg-hairline" />
      <div className="space-y-0.5">
        <Row label="Target" value={debug.targetId ?? "none"} />
        <Row
          label="Target range"
          value={
            telemetry.targetDistance !== undefined
              ? `${telemetry.targetDistance.toFixed(0)} m`
              : "-"
          }
        />
        <Row
          label="Target bearing"
          value={
            telemetry.targetBearing !== undefined
              ? `${telemetry.targetBearing.toFixed(1)}°`
              : "-"
          }
        />
        <Row
          label="Target visual"
          value={
            telemetry.targetVisibility !== undefined
              ? telemetry.targetVisibility.toFixed(2)
              : "-"
          }
        />
        <Row label="Enemies" value={String(debug.enemyCount)} />
        <Row label="Target AI" value={debug.targetAiState ?? "-"} />
        {debug.targetGate ? (
          <Row label="Rival gate" value={debug.targetGate} />
        ) : null}
        <Row
          label="AI confidence"
          value={debug.targetAiState ? debug.targetAiConfidence.toFixed(2) : "-"}
        />
        <Row
          label="AI terrain"
          value={
            debug.targetAiState
              ? debug.targetAiAvoiding
                ? `avoiding (${debug.targetAiClearance.toFixed(0)} m)`
                : Number.isFinite(debug.targetAiClearance)
                  ? `${debug.targetAiClearance.toFixed(0)} m clear`
                  : "unknown"
              : "-"
          }
        />
      </div>

      <div className="my-2 h-px bg-hairline" />
      <div className="space-y-0.5">
        <Row label="Aircraft" value={String(debug.aircraftCount)} />
        <Row
          label="Terrain cells"
          value={`${debug.terrainCells} (${debug.terrainDetailCells} fine)`}
        />
        {debug.terrainSurfaceBias !== 0 ? (
          <Row
            label="Surface bias"
            value={`${debug.terrainSurfaceBias >= 0 ? "+" : ""}${debug.terrainSurfaceBias.toFixed(2)} m`}
          />
        ) : null}
        <Row label="World detail" value={debug.worldDetail} />
        <Row
          label="Preloaded"
          value={`${(debug.preloadRadius / 1000).toFixed(1)} km, staged from ${Math.round(debug.preloadOverview)} m`}
        />
        <Row label="Mission time" value={`${debug.missionTime.toFixed(1)} s`} />
        <Row label="ion token" value={describeIonToken()} />
        <Row label="Maps key" value={describeGoogleMapsKey()} />
      </div>
    </div>
  );
}
