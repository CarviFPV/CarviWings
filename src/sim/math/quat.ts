/**
 * Quaternion maths for aircraft attitude.
 *
 * ## Conventions used everywhere in the simulation
 *
 * World frame — local ENU, right-handed:
 *   X = East, Y = North, Z = Up
 *
 * Body frame — right-handed, so that X x Y = Z:
 *   X = forward (nose), Y = left (port wing), Z = up (canopy)
 *
 * A quaternion `q` rotates **body-frame vectors into the world (ENU) frame**.
 * That means the columns of its rotation matrix are the world-space forward,
 * left and up axes of the aircraft.
 *
 * Rotations follow the right-hand rule about the body axes, which gives these
 * (initially unintuitive, hence documented) signs:
 *
 *   +X rotation -> left wing rises  -> **roll right**
 *   +Y rotation -> nose drops       -> **pitch down**
 *   +Z rotation -> nose swings left -> **yaw left**
 *
 * `angularVelocityFromCommands` is the single place that converts pilot-facing
 * commands (pitch up / roll right / yaw right positive) into this convention.
 */

import { clampUnit, DEG_TO_RAD, RAD_TO_DEG } from "./scalar";
import type { Vec3 } from "./vec3";
import * as V from "./vec3";

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export function quat(x = 0, y = 0, z = 0, w = 1): Quat {
  return { x, y, z, w };
}

export function identity(out: Quat): Quat {
  out.x = 0;
  out.y = 0;
  out.z = 0;
  out.w = 1;
  return out;
}

export function copyQuat(out: Quat, a: Quat): Quat {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  out.w = a.w;
  return out;
}

export function cloneQuat(a: Quat): Quat {
  return { x: a.x, y: a.y, z: a.z, w: a.w };
}

export function normalizeQuat(out: Quat, a: Quat): Quat {
  const lenSq = a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w;
  if (lenSq < 1e-12) return identity(out);
  const inv = 1 / Math.sqrt(lenSq);
  out.x = a.x * inv;
  out.y = a.y * inv;
  out.z = a.z * inv;
  out.w = a.w * inv;
  return out;
}

/**
 * Blend `t` of the way from `a` to `b`, normalised.
 *
 * Not a true slerp: the interpolation is linear in the components and only the
 * result is renormalised, so the angular rate is not constant across the arc.
 * For the per-step nudges this is used for — easing an attitude toward one the
 * ground is holding it in — the two are indistinguishable, and this costs a
 * square root rather than two trigonometric calls in the physics loop.
 */
export function nlerpQuat(out: Quat, a: Quat, b: Quat, t: number): Quat {
  // Quaternions double-cover rotations: without this the blend can take the
  // long way round and flip the aircraft over on its back.
  const sign = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  out.x = a.x + (b.x * sign - a.x) * t;
  out.y = a.y + (b.y * sign - a.y) * t;
  out.z = a.z + (b.z * sign - a.z) * t;
  out.w = a.w + (b.w * sign - a.w) * t;
  return normalizeQuat(out, out);
}

export function conjugate(out: Quat, a: Quat): Quat {
  out.x = -a.x;
  out.y = -a.y;
  out.z = -a.z;
  out.w = a.w;
  return out;
}

/** out = a * b (apply `b` first, then `a`). */
export function multiply(out: Quat, a: Quat, b: Quat): Quat {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

/** Rotate a body-frame vector into the world frame: out = q * v * q^-1. */
export function rotateVector(out: Vec3, q: Quat, v: Vec3): Vec3 {
  // t = 2 * (q.xyz x v);  out = v + q.w * t + q.xyz x t
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  out.x = v.x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = v.y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = v.z + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}

/** Rotate a world-frame vector into the body frame: out = q^-1 * v * q. */
export function rotateVectorInverse(out: Vec3, q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (-q.y * v.z + q.z * v.y);
  const ty = 2 * (-q.z * v.x + q.x * v.z);
  const tz = 2 * (-q.x * v.y + q.y * v.x);
  out.x = v.x + q.w * tx + (-q.y * tz + q.z * ty);
  out.y = v.y + q.w * ty + (-q.z * tx + q.x * tz);
  out.z = v.z + q.w * tz + (-q.x * ty + q.y * tx);
  return out;
}

export function fromAxisAngle(out: Quat, axis: Vec3, radians: number): Quat {
  const half = radians * 0.5;
  const s = Math.sin(half);
  out.x = axis.x * s;
  out.y = axis.y * s;
  out.z = axis.z * s;
  out.w = Math.cos(half);
  return normalizeQuat(out, out);
}

/**
 * Build an attitude quaternion from an orthonormal body basis expressed in
 * world coordinates. The basis must be right-handed: forward x left = up.
 */
export function fromBasis(out: Quat, forward: Vec3, left: Vec3, up: Vec3): Quat {
  // Rotation matrix columns are the world-space images of the body axes.
  const m00 = forward.x;
  const m10 = forward.y;
  const m20 = forward.z;
  const m01 = left.x;
  const m11 = left.y;
  const m21 = left.z;
  const m02 = up.x;
  const m12 = up.y;
  const m22 = up.z;

  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    out.w = 0.25 * s;
    out.x = (m21 - m12) / s;
    out.y = (m02 - m20) / s;
    out.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out.w = (m21 - m12) / s;
    out.x = 0.25 * s;
    out.y = (m01 + m10) / s;
    out.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out.w = (m02 - m20) / s;
    out.x = (m01 + m10) / s;
    out.y = 0.25 * s;
    out.z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out.w = (m10 - m01) / s;
    out.x = (m02 + m20) / s;
    out.y = (m12 + m21) / s;
    out.z = 0.25 * s;
  }
  return normalizeQuat(out, out);
}

const _fwd = V.vec3();
const _left = V.vec3();
const _up = V.vec3();
const _refRight = V.vec3();
const _refUp = V.vec3();
const _right = V.vec3();

/**
 * Build an attitude from aviation angles.
 *
 * @param headingDeg Compass heading in degrees, 0 = North, 90 = East.
 * @param pitchDeg   Nose-up positive.
 * @param rollDeg    Right-wing-down (right bank) positive.
 */
export function fromHeadingPitchRoll(
  out: Quat,
  headingDeg: number,
  pitchDeg: number,
  rollDeg: number,
): Quat {
  const h = headingDeg * DEG_TO_RAD;
  const p = pitchDeg * DEG_TO_RAD;
  const r = rollDeg * DEG_TO_RAD;

  const cp = Math.cos(p);
  V.set(_fwd, Math.sin(h) * cp, Math.cos(h) * cp, Math.sin(p));
  V.normalize(_fwd, _fwd);

  // Zero-roll reference axes: right = forward x up(world), up = right x forward.
  V.cross(_refRight, _fwd, V.UP as Vec3);
  if (V.lengthSquared(_refRight) < 1e-8) {
    // Pointing straight up or down: pick an arbitrary but stable reference.
    V.set(_refRight, Math.cos(h), -Math.sin(h), 0);
  }
  V.normalize(_refRight, _refRight);
  V.cross(_refUp, _refRight, _fwd);
  V.normalize(_refUp, _refUp);

  const cr = Math.cos(r);
  const sr = Math.sin(r);
  // Rolling right tilts the body-up axis toward the right wing.
  _up.x = _refUp.x * cr + _refRight.x * sr;
  _up.y = _refUp.y * cr + _refRight.y * sr;
  _up.z = _refUp.z * cr + _refRight.z * sr;
  _right.x = _refRight.x * cr - _refUp.x * sr;
  _right.y = _refRight.y * cr - _refUp.y * sr;
  _right.z = _refRight.z * cr - _refUp.z * sr;
  V.scale(_left, _right, -1);

  return fromBasis(out, _fwd, _left, _up);
}

export interface AttitudeAngles {
  /** Compass heading in degrees, 0 = North, 90 = East, range [0, 360). */
  headingDeg: number;
  /** Nose-up positive, range [-90, 90]. */
  pitchDeg: number;
  /** Right bank positive, range (-180, 180]. */
  rollDeg: number;
}

const BODY_X: Vec3 = { x: 1, y: 0, z: 0 };
const BODY_Y: Vec3 = { x: 0, y: 1, z: 0 };
const BODY_Z: Vec3 = { x: 0, y: 0, z: 1 };

export function forwardAxis(out: Vec3, q: Quat): Vec3 {
  return rotateVector(out, q, BODY_X);
}

export function leftAxis(out: Vec3, q: Quat): Vec3 {
  return rotateVector(out, q, BODY_Y);
}

export function upAxis(out: Vec3, q: Quat): Vec3 {
  return rotateVector(out, q, BODY_Z);
}

export function rightAxis(out: Vec3, q: Quat): Vec3 {
  rotateVector(out, q, BODY_Y);
  return V.scale(out, out, -1);
}

/** Decompose an attitude quaternion into heading / pitch / roll in degrees. */
export function toHeadingPitchRoll(q: Quat): AttitudeAngles {
  forwardAxis(_fwd, q);
  upAxis(_up, q);

  const headingDeg = (Math.atan2(_fwd.x, _fwd.y) * RAD_TO_DEG + 360) % 360;
  const pitchDeg = Math.asin(clampUnit(_fwd.z)) * RAD_TO_DEG;

  V.cross(_refRight, _fwd, V.UP as Vec3);
  if (V.lengthSquared(_refRight) < 1e-8) {
    // Vertical flight: roll is degenerate against a world reference.
    return { headingDeg, pitchDeg, rollDeg: 0 };
  }
  V.normalize(_refRight, _refRight);
  V.cross(_refUp, _refRight, _fwd);
  V.normalize(_refUp, _refUp);

  const rollDeg =
    Math.atan2(V.dot(_up, _refRight), V.dot(_up, _refUp)) * RAD_TO_DEG;
  return { headingDeg, pitchDeg, rollDeg };
}

const _spin = quat();
const _delta = quat();

/**
 * Integrate an attitude by a body-frame angular velocity (rad/s).
 *
 * Uses the exact exponential map rather than the linearised `q += 0.5*q*w*dt`
 * so that large rates over a long frame stay accurate and never inflate the
 * quaternion norm.
 */
export function integrateAngularVelocity(
  out: Quat,
  q: Quat,
  omegaBody: Vec3,
  dt: number,
): Quat {
  const rate = V.length(omegaBody);
  const angle = rate * dt;
  if (angle < 1e-9) return copyQuat(out, q);

  const half = angle * 0.5;
  // axis * sin(half) == omega * (sin(half) / rate), avoiding a normalise step.
  const s = Math.sin(half) / rate;
  _delta.x = omegaBody.x * s;
  _delta.y = omegaBody.y * s;
  _delta.z = omegaBody.z * s;
  _delta.w = Math.cos(half);

  // Body-frame rate: the incremental rotation is applied on the right.
  multiply(_spin, q, _delta);
  return normalizeQuat(out, _spin);
}

/**
 * Convert pilot-facing control rates into a body-frame angular velocity.
 *
 * Inputs are in the intuitive sense (positive = pitch **up**, roll **right**,
 * yaw **right**); the sign flips encode the body-axis conventions documented
 * at the top of this file.
 */
export function angularVelocityFromCommands(
  out: Vec3,
  rollRight: number,
  pitchUp: number,
  yawRight: number,
): Vec3 {
  out.x = rollRight;
  out.y = -pitchUp;
  out.z = -yawRight;
  return out;
}
