/**
 * Where an aircraft is drawn, as opposed to where the flight model last put it.
 *
 * The physics runs in whole fixed steps — 240 of them a second — and a display
 * shows a frame whenever it is ready to, which is almost never a whole number
 * of steps after the last one. At 144 Hz a frame is one and two-thirds steps
 * long, so consecutive frames advance the simulation by two steps, two steps,
 * one step: an aircraft drawn straight from the last step moves half as far in
 * every third frame as it does in the other two. Nothing is slow when that
 * happens, and the frame counter reads the same as ever, but everything that
 * moves across the picture judders — and other aircraft, which cross it
 * quickest and closest, judder the most. Even at 60 Hz, where a frame is four
 * steps exactly, the frame timer is never exact, and every few frames one
 * comes up a step short and the next a step long.
 *
 * The time left over after the last whole step is known, though: it is what the
 * accumulator is carrying. So each aircraft keeps the pose it had before the
 * most recent step, and what is drawn is the blend between that and the step
 * itself, as far along as the leftover says. The picture trails the flight
 * model by at most one step — four milliseconds — and in exchange moves by
 * exactly as much as the clock did, at any refresh rate.
 *
 * Strictly a view. Nothing in the flight model, the AI or the mission reads a
 * pose; they all go on reading the state, which is not touched.
 */

import type { AircraftState } from "../flight/state";
import type { Quat } from "../math/quat";
import { copyQuat, nlerpQuat, quat } from "../math/quat";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";

/** A place and an attitude. An `AircraftState` is one, structurally. */
export interface AircraftPose {
  readonly position: Vec3;
  readonly orientation: Quat;
}

interface PoseEntry {
  readonly previousPosition: Vec3;
  readonly previousOrientation: Quat;
  readonly position: Vec3;
  readonly orientation: Quat;
}

/**
 * How far an aircraft can move in one step and still be the same flight, m.
 *
 * Further than this in four milliseconds is a kilometre a second, which
 * nothing in the hangar does: it is an airframe that was picked up and put
 * somewhere else, and blending across that would draw it streaking between the
 * two places for a frame.
 */
const TELEPORT_DISTANCE = 4;
const TELEPORT_DISTANCE_SQUARED = TELEPORT_DISTANCE * TELEPORT_DISTANCE;

export class PoseInterpolator {
  /**
   * Keyed by the state object rather than by id: a replacement airframe keeps
   * the id of the one it replaces, and must not inherit where that one was.
   */
  private entries = new WeakMap<AircraftState, PoseEntry>();

  /** Records where every aircraft is. Called immediately before a step. */
  capture(aircraft: readonly AircraftState[]): void {
    for (const state of aircraft) {
      let entry = this.entries.get(state);
      if (!entry) {
        entry = {
          previousPosition: V.vec3(),
          previousOrientation: quat(),
          position: V.vec3(),
          orientation: quat(),
        };
        this.entries.set(state, entry);
      }
      V.copy(entry.previousPosition, state.position);
      copyQuat(entry.previousOrientation, state.orientation);
    }
  }

  /**
   * Works out the drawn pose of every aircraft.
   *
   * `alpha` is how far the clock has run past the last step, as a fraction of
   * a step: 0 draws the pose before that step and 1 the step itself.
   */
  blend(aircraft: readonly AircraftState[], alpha: number): void {
    const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    for (const state of aircraft) {
      const entry = this.entries.get(state);
      if (!entry) continue;
      const dx = state.position.x - entry.previousPosition.x;
      const dy = state.position.y - entry.previousPosition.y;
      const dz = state.position.z - entry.previousPosition.z;
      if (dx * dx + dy * dy + dz * dz > TELEPORT_DISTANCE_SQUARED) {
        V.copy(entry.position, state.position);
        copyQuat(entry.orientation, state.orientation);
        continue;
      }
      V.lerpVec3(entry.position, entry.previousPosition, state.position, t);
      nlerpQuat(
        entry.orientation,
        entry.previousOrientation,
        state.orientation,
        t,
      );
    }
  }

  /**
   * The pose to draw `state` at.
   *
   * An aircraft that has not been through a step yet — one spawned since the
   * last update — is drawn where it is.
   */
  poseOf(state: AircraftState): AircraftPose {
    return this.entries.get(state) ?? state;
  }

  /** Forgets everything, so every aircraft is drawn where it is. */
  reset(): void {
    this.entries = new WeakMap();
  }
}
