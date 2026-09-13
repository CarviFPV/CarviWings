/**
 * The simulation.
 *
 * Owns every aircraft, drives the flight model at a fixed timestep, resolves
 * terrain and aircraft collisions, and keeps the mission statistics. It knows
 * nothing about Cesium, React or the DOM — it is handed a coordinate frame and
 * a terrain sampler and produces state that a renderer can draw.
 *
 * Every aircraft is the same kind of object here, whatever it is doing. The
 * only difference is which controller is bound to it:
 *
 *                      FlightPhysics
 *                            ^
 *          ------------------+------------------
 *          |            |            |         |
 *   Keyboard/pad   EnemyController   Formation lead & wing
 */

import type { EnuFrame } from "../geo/enuFrame";
import type { AircraftRole, AircraftSpawn, AircraftState } from "../flight/state";
import {
  AIRCRAFT_ROLE,
  createAircraftState,
  FLIGHT_STATUS,
  isAirworthy,
  isGrounded,
  isHeld,
} from "../flight/state";
import {
  HAND_LAUNCH_AGL,
  releaseHandLaunch,
  stepHandLaunch,
} from "../flight/launch";
import type {
  AircraftDamage,
  DamageModel,
  DamageOutcome,
  ImpactSector,
} from "../flight/damage";
import {
  DAMAGE_MODEL,
  DAMAGE_OUTCOME,
  applyDamage,
  applyImpactMotion,
  createImpact,
  detonatingWarhead,
  impactSeverity,
  isCrippled,
  isDamaged,
  resolveImpact,
} from "../flight/damage";
import type { BlastKind } from "../render/explosionField";
import { BLAST_KIND } from "../render/explosionField";
import type { FlightEnvironment } from "../flight/physics";
import { PHYSICS_TIMESTEP, stepFlightDynamics } from "../flight/physics";
import type { GroundContactOptions, TouchdownLimits } from "../flight/ground";
import {
  classifyTouchdown,
  GROUND_CONTACT,
  groundContactFor,
  groundReleaseMarginFor,
  sinkIntoSurface,
  stepGroundContact,
  surfaceNormal,
  touchdownLimitsFor,
  TOUCHDOWN_VERDICT,
} from "../flight/ground";
import type { FlightStatistics, FlightTelemetry } from "../flight/telemetry";
import { createStatistics, createTelemetry } from "../flight/telemetry";
import type { FlightInput } from "../input/types";
import { createFlightInput } from "../input/types";
import { toHeadingPitchRoll } from "../math/quat";
import { clamp, RAD_TO_DEG } from "../math/scalar";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import type { CollisionWorld } from "../physics/collisionWorld";
import { groundUnderfoot } from "../terrain/footing";
import type { TerrainSampler } from "../terrain/types";
import type { WindField } from "../environment/wind";
import type { VisibilitySystem } from "../environment/visibility";
import type { VideoLink } from "../environment/videoLink";

/** Produces the control input for one aircraft each physics step. */
export type AircraftController = (
  state: AircraftState,
  dt: number,
) => FlightInput;

export interface SimulationOptions {
  readonly frame: EnuFrame;
  readonly terrain: TerrainSampler;
  readonly collision?: CollisionWorld | null;
  /** Mission radius in metres, measured horizontally from the origin. */
  readonly missionRadius: number;
  /** Moving air the aircraft fly through. Without one the air is still. */
  readonly wind?: WindField;
  /** Decides who can see whom. Without one everything is visible. */
  readonly visibility?: VisibilitySystem;
  /**
   * The channel the picture comes back over. Without one the pilot can see the
   * aircraft wherever it goes.
   */
  readonly videoLink?: VideoLink;
  /**
   * Height of an aircraft's reference point above the surface once its belly is
   * on it, metres. Doubles as the clearance at which contact is detected.
   *
   * Small on purpose: it is the thickness of an airframe, not a safety buffer.
   * Anything larger stops the aircraft visibly short of the ground, which is
   * what the terrain field's close-in grid exists to make unnecessary.
   */
  readonly groundClearance?: number;
  /** What a belly landing survives. Defaults to the airframe's own limits. */
  readonly touchdownLimits?: TouchdownLimits;
  /** How the airframe behaves once it is sliding. */
  readonly groundContact?: GroundContactOptions;
  /**
   * True when a contact between two aircraft actually damages them.
   *
   * On by default, and on in every mode that is flown for real: two wings
   * touching is a physical event rather than a rule, and a display routine or
   * a race is no more exempt from it than an interception is. What each of
   * them gets out of it differs only because of what the aircraft are
   * carrying — a charge on the wing ends a contact that a bare airframe
   * merely regrets.
   *
   * Off, a mid-air is still detected and reported but leaves both airframes
   * exactly as they were, which is what an intercept flown as a practice run
   * promises: contacts to find and shadow, and nothing that can be destroyed.
   */
  readonly contactDamage?: boolean;
  /** How airframes answer a contact. Defaults to `DAMAGE_MODEL`. */
  readonly damageModel?: DamageModel;
  /**
   * Which aircraft the HUD will track.
   *
   * Enemies on an intercept; the formation lead on a formation flight, where
   * the aircraft worth putting a box around is the one being flown on rather
   * than one being hunted.
   */
  readonly trackedRole?: AircraftRole;
}

/** Seconds spent in CRASHING before the mission registers the loss. */
const CRASH_SETTLE_SECONDS = 1.4;
/** How often the terrain cache is refreshed. */
const TERRAIN_REFRESH_INTERVAL = 0.1;
/** Never simulate more than this much real time in one frame. */
const MAX_FRAME_SECONDS = 0.25;

export interface CrashReport {
  readonly aircraftId: string;
  readonly impactSpeed: number;
  readonly reason: "TERRAIN" | "COLLISION";
}

/** An aircraft that met the ground and survived it. */
export interface LandingReport {
  readonly aircraftId: string;
  /** Closing speed along the surface normal at touchdown, m/s. */
  readonly sinkRate: number;
  /** Speed over the ground at touchdown, m/s. */
  readonly touchdownSpeed: number;
}

/** A collision the player was part of, lethal or not. */
export interface ContactReport {
  readonly playerId: string;
  readonly otherId: string;
  /** Speed of one aircraft relative to the other, m/s. */
  readonly closingSpeed: number;
  /**
   * The part of that speed carried into the structure, m/s.
   *
   * Never more than the closing speed and often very much less: a fast
   * crossing pass that barely touches puts almost none of its speed into
   * either airframe. This is the number the damage is worked out from.
   */
  readonly impactSpeed: number;
  /** Which part of the player's airframe the other aircraft arrived on. */
  readonly sector: ImpactSector;
  /** What the contact did to the player's airframe. */
  readonly outcome: DamageOutcome;
  /** True when a warhead went off. */
  readonly explosion: boolean;
  /** What is left of the player's airframe, 0..1. */
  readonly integrity: number;
  /** True when the contact wrote the player's airframe off. */
  readonly lethal: boolean;
}

/**
 * Something that should be seen from outside the aircraft it happened to.
 *
 * Raised for anyone's airframe, not just the player's: a contact exploding a
 * kilometre off the wing is one of the few things in this simulator worth
 * looking at, and the pilot has to be able to see it happen.
 */
export interface BlastReport {
  readonly aircraftId: string;
  readonly kind: BlastKind;
  /** Where it happened, local ENU metres. Owned by the report. */
  readonly position: Vec3;
  /** How the wreckage was already moving, m/s. Owned by the report. */
  readonly velocity: Vec3;
  /** 0..1: a wing letting go at the bottom, a charge going off at the top. */
  readonly strength: number;
}

/** Impact speed at which a wreck arriving on the ground throws its worst. */
const WORST_IMPACT_SPEED = 45;

export class Simulation {
  readonly frame: EnuFrame;
  readonly terrain: TerrainSampler;
  readonly aircraft: AircraftState[] = [];
  readonly statistics: FlightStatistics = createStatistics();
  readonly missionRadius: number;

  /** Mission elapsed time in seconds. */
  time = 0;

  private readonly collision: CollisionWorld | null;
  private readonly controllers = new Map<string, AircraftController>();
  private readonly environment: { wind: Vec3; originHeight: number };
  private readonly windField: WindField | null;
  readonly visibility: VisibilitySystem | null;
  readonly videoLink: VideoLink | null;
  /**
   * Ground behaviour, or null to take each airframe's own.
   *
   * A mission may pin one set of numbers for every aircraft in it, which is
   * what the tests do. Left alone, a wing lands on its belly and a multirotor
   * lands on its arms, because those are properties of the airframe rather
   * than of the sky it is being flown in.
   */
  private readonly groundClearance: number | null;
  private readonly touchdownLimits: TouchdownLimits | null;
  private readonly groundContact: GroundContactOptions | null;
  private readonly contactDamage: boolean;
  private readonly damageModel: DamageModel;
  private readonly trackedRole: AircraftRole;

  private readonly neutralInput: FlightInput = createFlightInput();
  private readonly telemetrySnapshot: FlightTelemetry = createTelemetry();
  private readonly scratch = V.vec3();
  private readonly groundNormal = V.vec3();
  // One contact seen from each airframe. Reused: a mid-air must not allocate.
  private readonly selfImpact = createImpact();
  private readonly otherImpact = createImpact();
  private readonly speedIntegral = { sum: 0, time: 0 };

  private accumulator = 0;
  private terrainTimer = 0;
  private playerId: string | null = null;
  private selectedTargetId: string | null = null;
  /** See `setLaunchSurface`. Null until something measures the launch point. */
  private launchSurface: number | null = null;

  private readonly crashes: CrashReport[] = [];
  private readonly landings: LandingReport[] = [];
  private readonly contacts: ContactReport[] = [];
  private readonly blasts: BlastReport[] = [];
  private playerContacts = 0;
  private playerKills = 0;

  constructor(options: SimulationOptions) {
    this.frame = options.frame;
    this.terrain = options.terrain;
    this.collision = options.collision ?? null;
    this.missionRadius = options.missionRadius;
    // The height contact is detected at and the height the airframe rests at
    // are the same number, and are kept as one: allowed to drift apart they
    // would land a wing at one height and settle it at another. Both stay null
    // unless the mission pinned them, and then each aircraft brings its own.
    const contact = options.groundContact ?? null;
    const clearance = options.groundClearance ?? contact?.restHeight ?? null;
    this.groundClearance = clearance;
    this.groundContact =
      contact === null
        ? clearance === null
          ? null
          : { ...GROUND_CONTACT, restHeight: clearance }
        : contact.restHeight === clearance
          ? contact
          : { ...contact, restHeight: clearance ?? contact.restHeight };
    this.touchdownLimits = options.touchdownLimits ?? null;
    this.contactDamage = options.contactDamage ?? true;
    this.damageModel = options.damageModel ?? DAMAGE_MODEL;
    this.trackedRole = options.trackedRole ?? AIRCRAFT_ROLE.Enemy;
    this.windField = options.wind ?? null;
    this.visibility = options.visibility ?? null;
    this.videoLink = options.videoLink ?? null;
    this.environment = {
      wind: V.vec3(),
      originHeight: options.frame.origin.height,
    };
  }

  get player(): AircraftState | null {
    if (!this.playerId) return null;
    return this.aircraft.find((a) => a.id === this.playerId) ?? null;
  }

  /** The wind the last stepped aircraft flew through, in local ENU m/s. */
  get wind(): Readonly<Vec3> {
    return this.environment.wind;
  }

  /** Wind speed at the player's height, m/s. */
  get windSpeed(): number {
    if (!this.windField) return 0;
    const player = this.player;
    return this.windField.speedAt(player ? player.altitudeAgl : 100);
  }

  /**
   * Compass direction the wind blows *from* at the player's height, degrees.
   *
   * Read at the aircraft rather than at the surface, like the speed beside it:
   * the wind veers with height, and an OSD quoting the surface wind while the
   * aircraft drifts the other way is worse than no wind readout at all.
   */
  get windDirectionDeg(): number {
    if (!this.windField) return 0;
    const player = this.player;
    return this.windField.directionAt(player ? player.altitudeAgl : 100);
  }

  /** Enemy aircraft still in the air. */
  get enemyCount(): number {
    let count = 0;
    for (const state of this.aircraft) {
      if (state.role === AIRCRAFT_ROLE.Enemy && isAirworthy(state.status)) {
        count += 1;
      }
    }
    return count;
  }

  /** The aircraft a formation is flown on, while it is still flying. */
  get lead(): AircraftState | null {
    return (
      this.aircraft.find(
        (a) => a.role === AIRCRAFT_ROLE.Lead && isAirworthy(a.status),
      ) ?? null
    );
  }

  /** Lead and wingmen still in the air. */
  get formationCount(): number {
    let count = 0;
    for (const state of this.aircraft) {
      if (!isAirworthy(state.status)) continue;
      if (state.role === AIRCRAFT_ROLE.Lead || state.role === AIRCRAFT_ROLE.Wingman) {
        count += 1;
      }
    }
    return count;
  }

  /** The aircraft the HUD is currently tracking, if it is still flying. */
  get target(): AircraftState | null {
    if (!this.selectedTargetId) return null;
    const target = this.aircraft.find((a) => a.id === this.selectedTargetId);
    if (!target || !isAirworthy(target.status)) return null;
    return target;
  }

  selectTarget(id: string | null): void {
    this.selectedTargetId = id;
  }

  /**
   * Trackable aircraft ordered by range from the player, nearest first.
   *
   * "Trackable" is whatever the mission put a box around: enemies on an
   * intercept, the formation lead on a formation flight.
   */
  trackableAircraft(): AircraftState[] {
    const player = this.player;
    const enemies = this.aircraft.filter(
      (a) => a.role === this.trackedRole && isAirworthy(a.status),
    );
    if (!player) return enemies;
    return enemies.sort(
      (a, b) =>
        V.distance(a.position, player.position) -
        V.distance(b.position, player.position),
    );
  }

  /** Steps the selection to the next contact by range. Returns the new target. */
  cycleTarget(): AircraftState | null {
    const enemies = this.trackableAircraft();
    if (enemies.length === 0) {
      this.selectedTargetId = null;
      return null;
    }
    const index = enemies.findIndex((a) => a.id === this.selectedTargetId);
    const next = enemies[(index + 1) % enemies.length] as AircraftState;
    this.selectedTargetId = next.id;
    return next;
  }

  /**
   * Where the tracked contact sits in the range-ordered list, 1-based, and how
   * many there are.
   *
   * The HUD needs both to say "2/5". Without it, cycling to a contact that is
   * off-screen or lost in the weather looks exactly like a key that did
   * nothing, which is the difference between having the option to change
   * target and being able to use it.
   *
   * `index` is 0 when nothing is tracked.
   */
  targetPosition(): { index: number; count: number } {
    const contacts = this.trackableAircraft();
    const index = contacts.findIndex((a) => a.id === this.selectedTargetId);
    return { index: index + 1, count: contacts.length };
  }

  /**
   * Keeps a valid target selected without the pilot having to ask: when the
   * current one is destroyed or never existed, fall back to the nearest.
   */
  private refreshTarget(): void {
    if (this.target) return;
    const player = this.player;
    if (!player) {
      this.selectedTargetId = null;
      return;
    }
    let nearest: AircraftState | null = null;
    let nearestRange = Infinity;
    for (const state of this.aircraft) {
      if (state.role !== this.trackedRole) continue;
      if (!isAirworthy(state.status)) continue;
      const range = V.distance(state.position, player.position);
      if (range < nearestRange) {
        nearestRange = range;
        nearest = state;
      }
    }
    this.selectedTargetId = nearest ? nearest.id : null;
  }

  spawn(spawn: AircraftSpawn, controller?: AircraftController): AircraftState {
    const state = createAircraftState(spawn);
    // Anchor the aircraft to the terrain immediately so the very first frame
    // already reports a correct AGL rather than a zero.
    state.terrainHeight = this.terrain.heightAt(state.position.x, state.position.y);
    state.altitudeAgl = state.position.z - state.terrainHeight;

    this.aircraft.push(state);
    if (controller) this.controllers.set(state.id, controller);
    if (spawn.role === AIRCRAFT_ROLE.Player) this.playerId = state.id;
    this.collision?.add(state.id, state.position, state.config.collisionRadius);
    return state;
  }

  setController(id: string, controller: AircraftController): void {
    this.controllers.set(id, controller);
  }

  /**
   * The ground a held launch is set up on, in local metres, when somebody has
   * measured it rather than read it off the height field.
   *
   * The field describes bare earth, and where the scene draws something else
   * over it — a photogrammetry canopy, most of all — a wing held at head height
   * over the bare earth is a wing held inside a wood. Whoever can see the drawn
   * surface measures it and passes it in here, and a held wing is never held
   * below it. Null where nothing has been measured, which is every mission that
   * does not begin on a field.
   */
  setLaunchSurface(height: number | null): void {
    this.launchSurface =
      height !== null && Number.isFinite(height) ? height : null;
  }

  remove(id: string): void {
    const index = this.aircraft.findIndex((a) => a.id === id);
    if (index >= 0) this.aircraft.splice(index, 1);
    this.controllers.delete(id);
    this.collision?.remove(id);
    if (this.playerId === id) this.playerId = null;
    if (this.selectedTargetId === id) this.selectedTargetId = null;
  }

  /** Crash reports produced since the last call. The array is drained. */
  drainCrashes(): CrashReport[] {
    return this.crashes.splice(0, this.crashes.length);
  }

  /** Touchdowns since the last call. The array is drained. */
  drainLandings(): LandingReport[] {
    return this.landings.splice(0, this.landings.length);
  }

  /**
   * Explosions, break-ups and ground impacts since the last call, for whoever
   * is drawing them. The array is drained.
   */
  drainBlasts(): BlastReport[] {
    return this.blasts.splice(0, this.blasts.length);
  }

  /**
   * Collisions the player has been part of since the mission began.
   *
   * A running total rather than a queue: the reports are drained by whoever
   * makes the noise, and a rule that ends the mission on contact must not have
   * to compete for them.
   */
  get playerContactCount(): number {
    return this.playerContacts;
  }

  /**
   * Contacts the player has taken out by flying into them, since the mission
   * began.
   *
   * `statistics.enemiesDestroyed` counts every contact that stopped being an
   * aircraft, however it happened — two of them meeting each other, one of them
   * flying into a hill. This counts only the ones the pilot arrived on, which
   * is the difference between an airframe spent and an airframe wasted: on a
   * mission flown with the charge on the wing, losing the wing on a contact is
   * the mission working.
   */
  get playerKillCount(): number {
    return this.playerKills;
  }

  /**
   * Player collisions since the last call. The array is drained.
   *
   * Reported whether or not contacts do damage: a wing hitting another wing is
   * worth hearing on a training flight too, it just costs less there.
   */
  drainContacts(): ContactReport[] {
    return this.contacts.splice(0, this.contacts.length);
  }

  /**
   * Advances the simulation by up to `elapsed` seconds of real time using whole
   * fixed steps. Any remainder is carried into the next frame, so the physics
   * is frame-rate independent and reproducible.
   */
  update(elapsed: number): void {
    const clamped = Math.min(Math.max(elapsed, 0), MAX_FRAME_SECONDS);

    this.terrainTimer += clamped;
    if (this.terrainTimer >= TERRAIN_REFRESH_INTERVAL) {
      this.refreshTerrain(this.terrainTimer);
      this.terrainTimer = 0;
    }

    this.windField?.update(clamped);
    // Stepped per frame rather than per physics step: the link is a
    // slow-moving signal and nothing in the flight model reads it.
    this.videoLink?.update(this.player, clamped);

    this.accumulator += clamped;
    while (this.accumulator >= PHYSICS_TIMESTEP) {
      this.step(PHYSICS_TIMESTEP);
      this.accumulator -= PHYSICS_TIMESTEP;
    }

    this.refreshTarget();
  }

  private refreshTerrain(dt: number): void {
    // Only the player drives the warm area; enemies read whatever is cached and
    // fall back gracefully, which is far cheaper than warming N regions.
    const player = this.player;
    if (player) {
      this.terrain.refresh(player.position, player.velocity, dt);
    } else if (this.aircraft.length > 0) {
      const first = this.aircraft[0] as AircraftState;
      this.terrain.refresh(first.position, first.velocity, dt);
    }
  }

  private step(dt: number): void {
    this.time += dt;

    for (const state of this.aircraft) {
      if (state.status === FLIGHT_STATUS.Destroyed) continue;

      if (state.status === FLIGHT_STATUS.Crashing) {
        state.crashTimer += dt;
        if (state.crashTimer >= CRASH_SETTLE_SECONDS) {
          state.status = FLIGHT_STATUS.Crashed;
        }
        continue;
      }
      if (state.status === FLIGHT_STATUS.Crashed) continue;

      // A wreck has no pilot. It keeps falling through the same aerodynamics
      // with the controls centred, which is what makes a disabled airframe
      // spin down rather than vanish.
      const airworthy = isAirworthy(state.status);
      const controller = airworthy ? this.controllers.get(state.id) : undefined;
      const input = controller ? controller(state, dt) : this.neutralInput;

      // A wing still in the launcher's hand is not being flown yet. It is held
      // exactly where it is, over ground that is re-read every step in case the
      // terrain under the field is still arriving, and the only thing the
      // sticks reach is the motor — until the throttle is open, and then it is
      // thrown and the rest of this loop has an aircraft again.
      if (isHeld(state.status)) {
        // Held over the ground that is actually there, and over the ground the
        // launcher is standing on rather than the column under the wing: on a
        // slope those are metres apart, and the one that decides whether the
        // wing is at head height or in the hillside is the one with somebody's
        // feet on it. An unsampled cell is missing data rather than sea level,
        // and standing a launch on it would throw the wing out of a hole the
        // moment the tile arrived.
        const measured = this.launchSurface;
        const underfoot = this.terrain.hasCoverage(
          state.position.x,
          state.position.y,
        )
          ? groundUnderfoot(this.terrain, state.position.x, state.position.y)
          : state.position.z - HAND_LAUNCH_AGL;
        const ground =
          measured === null ? underfoot : Math.max(underfoot, measured);
        if (stepHandLaunch(state, input.throttle, ground, dt)) {
          releaseHandLaunch(state);
        }
        this.collision?.sync(state.id, state.position, state.velocity);
        continue;
      }

      // Air moves faster the higher you are, so each aircraft is stepped
      // through the wind at its own height rather than a single mission-wide
      // value.
      if (this.windField) {
        this.windField.sample(state.altitudeAgl, this.environment.wind);
      }
      stepFlightDynamics(state, input, this.environment, dt);

      state.terrainHeight = this.terrain.heightAt(state.position.x, state.position.y);
      state.altitudeAgl = state.position.z - state.terrainHeight;

      // An aircraft already down keeps its ground state until it is properly
      // clear, so a float in the flare is not read as a take-off followed by a
      // second landing.
      const clearance = this.clearanceFor(state);
      const reach = isGrounded(state.status)
        ? clearance + groundReleaseMarginFor(state.config)
        : clearance;

      // Only ground the aircraft against terrain that has actually been
      // sampled. An unsampled cell is missing data, not a mountain, and must
      // never be allowed to destroy an aircraft.
      if (
        state.altitudeAgl <= reach &&
        this.terrain.hasCoverage(state.position.x, state.position.y)
      ) {
        // A disabled airframe never lands. Whatever it arrives on, it arrives
        // on as a wreck, and there is no approach left to judge.
        if (!airworthy) {
          this.impactTerrain(state);
          continue;
        }
        if (this.resolveGroundContact(state, input, dt)) continue;
      } else if (isGrounded(state.status)) {
        // Clear of the surface with nothing holding it there: it flew off.
        state.status = FLIGHT_STATUS.Flying;
      }

      this.collision?.sync(state.id, state.position, state.velocity);
    }

    this.stepCollisions(dt);
    this.accumulateStatistics(dt);
  }

  private stepCollisions(dt: number): void {
    if (!this.collision) return;
    const events = this.collision.step(dt);
    if (events.length === 0) return;

    for (const event of events) {
      const a = this.aircraft.find((s) => s.id === event.a);
      const b = this.aircraft.find((s) => s.id === event.b);
      if (!a || !b) continue;
      if (!isAirworthy(a.status) || !isAirworthy(b.status)) {
        continue;
      }

      this.statistics.collisions += 1;
      this.resolveMidAir(a, b, event.closingSpeed);
    }
  }

  /**
   * Works out what two aircraft did to each other.
   *
   * Both airframes are judged from their own point of view — the same contact
   * is a wingtip strike for one aircraft and a nose-on hit for the other, and
   * they are not owed the same damage. What they do share is the speed that
   * actually arrived, and the fuze: a charge is either fired by the contact or
   * it is not, and if it fires nobody walks away.
   */
  private resolveMidAir(
    a: AircraftState,
    b: AircraftState,
    closingSpeed: number,
  ): void {
    const model = this.damageModel;
    const self = resolveImpact(this.selfImpact, a, b);
    const other = resolveImpact(this.otherImpact, b, a);

    // With damage off a contact is reported and nothing more, and no fuze
    // fires either, however hard the two aircraft met.
    const warhead = this.contactDamage
      ? detonatingWarhead(a, b, self.normalSpeed)
      : null;

    let outcomeA: DamageOutcome = DAMAGE_OUTCOME.Scrape;
    let outcomeB: DamageOutcome = DAMAGE_OUTCOME.Scrape;
    if (this.contactDamage) {
      const severityA = warhead ? warhead.charge : impactSeverity(self, model);
      const severityB = warhead ? warhead.charge : impactSeverity(other, model);
      outcomeA = applyDamage(a.damage, self, severityA, model);
      outcomeB = applyDamage(b.damage, other, severityB, model);
      applyImpactMotion(a, self, severityA, model);
      applyImpactMotion(b, other, severityB, model);
      // Only a charge takes an airframe out of the sky on the spot. Without
      // one, whatever the contact left is still a physical object with the
      // ground under it.
      const disintegrated = warhead !== null;
      this.applyOutcome(a, outcomeA, disintegrated);
      this.applyOutcome(b, outcomeB, disintegrated);

      if (warhead) {
        // One charge, one fireball, and it belongs between the two aircraft
        // rather than on either of them.
        this.blasts.push({
          aircraftId: a.id,
          kind: BLAST_KIND.Detonation,
          position: V.lerpVec3(V.vec3(), a.position, b.position, 0.5),
          velocity: V.lerpVec3(V.vec3(), a.velocity, b.velocity, 0.5),
          strength: 1,
        });
      } else {
        this.raiseBreakUp(a, outcomeA);
        this.raiseBreakUp(b, outcomeB);
      }
    }

    const player =
      a.role === AIRCRAFT_ROLE.Player
        ? a
        : b.role === AIRCRAFT_ROLE.Player
          ? b
          : null;
    if (!player) return;

    const isA = player === a;
    const outcome = isA ? outcomeA : outcomeB;
    const struck = isA ? b : a;
    const struckOutcome = isA ? outcomeB : outcomeA;
    this.playerContacts += 1;
    // A contact the pilot arrived on and left as a wreck is a kill, whether the
    // charge fired or the impact alone finished it.
    if (
      struck.role === AIRCRAFT_ROLE.Enemy &&
      (struckOutcome === DAMAGE_OUTCOME.Destroyed ||
        struckOutcome === DAMAGE_OUTCOME.Disabled)
    ) {
      this.playerKills += 1;
    }
    this.contacts.push({
      playerId: player.id,
      otherId: struck.id,
      closingSpeed,
      impactSpeed: self.normalSpeed,
      sector: (isA ? self : other).sector,
      outcome,
      explosion: warhead !== null,
      integrity: player.damage.integrity,
      lethal:
        outcome === DAMAGE_OUTCOME.Destroyed ||
        outcome === DAMAGE_OUTCOME.Disabled,
    });
  }

  /**
   * Draws attention to an airframe that came apart without a charge to do it.
   *
   * Quieter than a detonation and quieter again when the wing merely stopped
   * flying: what is seen is structure failing, and it should not be mistaken
   * for a warhead by anybody watching from a kilometre away.
   */
  private raiseBreakUp(state: AircraftState, outcome: DamageOutcome): void {
    if (
      outcome !== DAMAGE_OUTCOME.Destroyed &&
      outcome !== DAMAGE_OUTCOME.Disabled
    ) {
      return;
    }
    this.blasts.push({
      aircraftId: state.id,
      kind: BLAST_KIND.BreakUp,
      position: V.clone(state.position),
      velocity: V.clone(state.velocity),
      strength: outcome === DAMAGE_OUTCOME.Destroyed ? 1 : 0.45,
    });
  }

  /**
   * Puts one airframe into whatever state the contact left it in.
   *
   * An airframe that is still flying needs nothing done to it: the damage is
   * already on it, and the flight model will make the pilot feel it. The other
   * two outcomes take the aircraft out of the collision world — a wreck on its
   * way down is scenery, not a hazard to fly into.
   *
   * Nothing stops existing in mid-air unless something blew it apart. A charge
   * going off leaves nothing to fall and the aircraft is simply gone; an
   * airframe written off by the impact alone is still foam, wire and a motor
   * with a kilometre of air underneath it, so it comes apart, stops being an
   * aircraft, and goes down. Whatever it was flying, it finishes on the
   * ground: `disintegrated` is the only thing that says otherwise.
   */
  private applyOutcome(
    state: AircraftState,
    outcome: DamageOutcome,
    disintegrated: boolean,
  ): void {
    if (
      outcome !== DAMAGE_OUTCOME.Destroyed &&
      outcome !== DAMAGE_OUTCOME.Disabled
    ) {
      return;
    }

    state.status =
      outcome === DAMAGE_OUTCOME.Destroyed && disintegrated
        ? FLIGHT_STATUS.Destroyed
        : FLIGHT_STATUS.Disabled;
    state.throttleCommand = 0;
    this.collision?.remove(state.id);
    // Credited the moment the airframe stops being an aircraft: a contact
    // spinning down through two thousand feet is not coming back, and the
    // mission should not wait for it to land to say so.
    if (state.role === AIRCRAFT_ROLE.Enemy) {
      this.statistics.enemiesDestroyed += 1;
    }
  }

  /** How this airframe behaves on the ground, unless the mission pinned one. */
  private contactFor(state: AircraftState): GroundContactOptions {
    return this.groundContact ?? groundContactFor(state.config);
  }

  /** How high this airframe's reference point sits when it is resting. */
  private clearanceFor(state: AircraftState): number {
    return this.groundClearance ?? groundContactFor(state.config).restHeight;
  }

  /** What separates a landing from a crash for this airframe. */
  private limitsFor(state: AircraftState): TouchdownLimits {
    return this.touchdownLimits ?? touchdownLimitsFor(state.config);
  }

  /**
   * Decides what an aircraft touching the ground means, and applies it.
   *
   * The first contact is the one that is judged: flown on gently the aircraft
   * starts sliding, flown in hard it is a crash. Afterwards only the sink rate
   * is re-checked each step, which is what catches a slide that runs off a
   * drop or into a bank — the rest of the touchdown criteria describe an
   * approach and have nothing to say about an aircraft already on its belly.
   *
   * Returns true when the contact wrote the airframe off.
   */
  private resolveGroundContact(
    state: AircraftState,
    input: FlightInput,
    dt: number,
  ): boolean {
    surfaceNormal(
      this.groundNormal,
      this.terrain,
      state.position.x,
      state.position.y,
    );

    if (!isGrounded(state.status)) {
      if (
        classifyTouchdown(state, this.groundNormal, this.limitsFor(state)) ===
        TOUCHDOWN_VERDICT.Crash
      ) {
        this.impactTerrain(state);
        return true;
      }
      state.status = FLIGHT_STATUS.Sliding;
      this.statistics.landings += 1;
      this.landings.push({
        aircraftId: state.id,
        sinkRate: Math.max(sinkIntoSurface(state.velocity, this.groundNormal), 0),
        touchdownSpeed: V.length(state.velocity),
      });
    } else if (
      sinkIntoSurface(state.velocity, this.groundNormal) >
      this.limitsFor(state).sinkRate
    ) {
      this.impactTerrain(state);
      return true;
    }

    const result = stepGroundContact(
      state,
      state.terrainHeight,
      this.groundNormal,
      input.pitch,
      dt,
      this.contactFor(state),
    );
    state.status =
      result.touching && result.stopped
        ? FLIGHT_STATUS.Landed
        : FLIGHT_STATUS.Sliding;
    // The ground step only moves the aircraft vertically, so the terrain
    // underneath it is the height already sampled this step.
    state.altitudeAgl = state.position.z - state.terrainHeight;
    return false;
  }

  private impactTerrain(state: AircraftState): void {
    const impactSpeed = V.length(state.velocity);
    this.blasts.push({
      aircraftId: state.id,
      kind: BLAST_KIND.Impact,
      position: V.clone(state.position),
      velocity: V.clone(state.velocity),
      strength: clamp(impactSpeed / WORST_IMPACT_SPEED, 0.25, 1),
    });
    state.status = FLIGHT_STATUS.Crashing;
    state.crashTimer = 0;
    // Settle the wreck on the surface instead of letting it sink through.
    state.position.z = state.terrainHeight + this.clearanceFor(state);
    V.set(state.velocity, 0, 0, 0);
    V.set(state.angularVelocity, 0, 0, 0);
    state.throttle = 0;
    state.throttleCommand = 0;
    state.altitudeAgl = this.clearanceFor(state);
    this.collision?.remove(state.id);
    this.statistics.crashes += 1;
    this.crashes.push({
      aircraftId: state.id,
      impactSpeed,
      // A wreck that was already falling did not crash into the terrain: the
      // terrain is simply where the mid-air finished.
      reason: isCrippled(state.damage, this.damageModel) ? "COLLISION" : "TERRAIN",
    });
  }

  private accumulateStatistics(dt: number): void {
    const player = this.player;
    // A landed aircraft is still the pilot's aircraft: the clock keeps running
    // until the airframe is actually lost, so a sortie that ends on the ground
    // reads as one flight rather than as one that stopped at the flare.
    if (!player || !isAirworthy(player.status)) return;

    const stats = this.statistics;
    stats.flightTime += dt;
    stats.distanceFlown += player.groundSpeed * dt;
    stats.maxAirspeed = Math.max(stats.maxAirspeed, player.airspeed);
    stats.maxAltitudeAgl = Math.max(stats.maxAltitudeAgl, player.altitudeAgl);

    this.speedIntegral.sum += player.airspeed * dt;
    this.speedIntegral.time += dt;
    stats.averageAirspeed =
      this.speedIntegral.time > 0
        ? this.speedIntegral.sum / this.speedIntegral.time
        : 0;

    // Max altitude is tracked in geodetic metres, so it needs the real height.
    const geo = this.frame.localToGeographic(player.position);
    stats.maxAltitude = Math.max(stats.maxAltitude, geo.height);
  }

  /**
   * Builds an instrument snapshot. Allocation-free: the same object is
   * returned every call, so callers must read it rather than retain it.
   */
  telemetry(): FlightTelemetry {
    const t = this.telemetrySnapshot;
    const player = this.player;
    if (!player) return t;

    const geo = this.frame.localToGeographic(player.position);
    const angles = toHeadingPitchRoll(player.orientation);

    t.airspeed = player.airspeed;
    t.groundSpeed = player.groundSpeed;
    t.altitude = geo.height;
    t.altitudeAgl = player.altitudeAgl;
    t.verticalSpeed = player.velocity.z;
    t.throttle = player.throttle;
    t.heading = angles.headingDeg;
    t.pitch = angles.pitchDeg;
    t.roll = angles.rollDeg;
    t.latitude = geo.latitude;
    t.longitude = geo.longitude;
    // Terrain is cached in local ENU metres; lift it back to geodetic height.
    t.terrainHeight = geo.height - player.altitudeAgl;
    t.loadFactor = player.loadFactor;
    t.stalled = player.stalled;
    t.integrity = player.damage.integrity;
    t.damaged = isDamaged(player.damage);
    t.controlAuthority = controlAuthority(player.damage);
    t.disabled = player.status === FLIGHT_STATUS.Disabled;
    t.grounded = isGrounded(player.status);
    t.held = isHeld(player.status);
    t.landed = player.status === FLIGHT_STATUS.Landed;
    t.windSpeed = this.windSpeed;
    t.windDirection = this.windDirectionDeg;

    // The pack is the player's own hardware rather than a mission system, so
    // it is read off the airframe instead of off the simulation.
    const plant = player.powerplant;
    t.batteryEnabled = plant !== null;
    t.batteryCharge = plant ? plant.charge : 1;
    t.batteryVoltage = plant ? plant.voltage : 0;
    // A tank has no cells to divide by, and nought volts a cell is the honest
    // reading on an aeroplane whose power system is a bag of petrol.
    t.batteryCellVoltage =
      plant && plant.battery.cells > 0
        ? plant.voltage / plant.battery.cells
        : 0;
    t.batteryCurrent = plant ? plant.current : 0;
    t.batteryConsumedMah = plant ? plant.consumedMah : 0;
    t.batteryCapacityMah = plant ? plant.battery.capacityMah : 0;
    t.batteryEnduranceSeconds = plant
      ? plant.enduranceSeconds
      : Number.POSITIVE_INFINITY;
    t.batteryCut = plant ? plant.cut : false;

    // An aeroplane with an engine on it runs the same gauge on a different
    // liquid: how full, how long left and whether it has stopped all mean what
    // they meant, and the three electrical readings beside them do not exist.
    const tank = plant?.battery.fuel ?? null;
    t.fuelled = tank !== null;
    t.fuelLitres = plant && tank ? plant.fuelLitres : 0;
    t.fuelCapacityLitres = tank ? tank.litres : 0;
    t.fuelBurnLitresPerHour = plant && tank ? plant.fuelBurnLitresPerHour : 0;

    const link = this.videoLink?.state;
    t.videoLinkEnabled = link ? link.enabled : false;
    t.videoQuality = link ? link.quality : 1;
    t.videoRange = link ? link.range : Number.POSITIVE_INFINITY;
    t.videoDistance = link ? link.distance : 0;
    t.videoLostSeconds = link ? link.lostSeconds : 0;
    t.videoLossTimeout = link ? link.timeout : 0;

    const horizontal = Math.hypot(player.position.x, player.position.y);
    t.distanceFromOrigin = horizontal;
    t.outsideMissionArea = horizontal > this.missionRadius;

    const target = this.target;
    if (target) {
      V.subtract(this.scratch, target.position, player.position);
      t.targetDistance = V.length(this.scratch);
      t.targetBearing =
        (Math.atan2(this.scratch.x, this.scratch.y) * RAD_TO_DEG + 360) % 360;
      t.targetVisibility = this.visibility
        ? this.visibility.targetVisibility(player, target)
        : 1;
    } else {
      delete t.targetDistance;
      delete t.targetBearing;
      delete t.targetVisibility;
    }

    return t;
  }

  dispose(): void {
    this.aircraft.length = 0;
    this.controllers.clear();
  }
}

/**
 * The weakest of the three control axes.
 *
 * What the pilot notices about a damaged wing is whichever axis has gone, not
 * an average of the three, so the instrument reports the worst one.
 */
function controlAuthority(damage: AircraftDamage): number {
  return Math.min(
    damage.rollAuthority,
    damage.pitchAuthority,
    damage.yawAuthority,
  );
}
