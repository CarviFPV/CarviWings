import { assert, assertClose, suite } from "./harness";
import * as Q from "../math/quat";
import * as V from "../math/vec3";
import { createRng } from "../math/rng";

export function runMathTests(): void {
  suite("quaternion attitude", () => {
    const q = Q.quat();

    // Level flight heading north.
    Q.fromHeadingPitchRoll(q, 0, 0, 0);
    const fwd = Q.forwardAxis(V.vec3(), q);
    assertClose(fwd.x, 0, 1e-9, "heading 000 forward has no east component");
    assertClose(fwd.y, 1, 1e-9, "heading 000 forward points north");
    assertClose(fwd.z, 0, 1e-9, "heading 000 forward is level");

    Q.fromHeadingPitchRoll(q, 90, 0, 0);
    Q.forwardAxis(fwd, q);
    assertClose(fwd.x, 1, 1e-9, "heading 090 forward points east");

    Q.fromHeadingPitchRoll(q, 0, 30, 0);
    Q.forwardAxis(fwd, q);
    assertClose(fwd.z, Math.sin((30 * Math.PI) / 180), 1e-9, "pitch 30 climbs");

    // Right bank puts the body-up axis over the right wing (east when flying north).
    Q.fromHeadingPitchRoll(q, 0, 0, 45);
    const up = Q.upAxis(V.vec3(), q);
    assert(up.x > 0.7 && up.z > 0.7, "right bank tilts body up toward the east");

    const right = Q.rightAxis(V.vec3(), q);
    assert(right.z < -0.7, "right bank drops the right wing");

    for (const [h, p, r] of [
      [0, 0, 0],
      [37, 12, -25],
      [190, -40, 120],
      [359, 80, 179],
      [275, -75, -160],
    ] as const) {
      Q.fromHeadingPitchRoll(q, h, p, r);
      const angles = Q.toHeadingPitchRoll(q);
      assertClose(angles.headingDeg, (h + 360) % 360, 1e-6, `heading round-trip ${h}`);
      assertClose(angles.pitchDeg, p, 1e-6, `pitch round-trip ${p}`);
      // Compare wrapped so 180 and -180 are the same attitude.
      const rollError = Math.abs(((angles.rollDeg - r + 540) % 360) - 180);
      assertClose(rollError, 0, 1e-6, `roll round-trip ${r}`);
    }
  });

  suite("angular integration", () => {
    const q = Q.quat();
    Q.fromHeadingPitchRoll(q, 0, 0, 0);

    // A positive body-X rate must roll right; integrate 90 degrees in 1 s.
    const omega = V.vec3(Math.PI / 2, 0, 0);
    const dt = 1 / 480;
    for (let i = 0; i < 480; i += 1) {
      Q.integrateAngularVelocity(q, q, omega, dt);
    }
    const angles = Q.toHeadingPitchRoll(q);
    assertClose(angles.rollDeg, 90, 0.05, "body +X rate integrates to right roll");
    assertClose(angles.pitchDeg, 0, 0.05, "pure roll leaves pitch alone");

    // Pitch-up command must raise the nose.
    Q.fromHeadingPitchRoll(q, 0, 0, 0);
    const cmd = Q.angularVelocityFromCommands(V.vec3(), 0, Math.PI / 4, 0);
    for (let i = 0; i < 480; i += 1) {
      Q.integrateAngularVelocity(q, q, cmd, dt);
    }
    assertClose(
      Q.toHeadingPitchRoll(q).pitchDeg,
      45,
      0.05,
      "pitch-up command integrates to nose up",
    );

    // Yaw-right command must increase heading.
    Q.fromHeadingPitchRoll(q, 0, 0, 0);
    Q.angularVelocityFromCommands(cmd, 0, 0, Math.PI / 4);
    for (let i = 0; i < 480; i += 1) {
      Q.integrateAngularVelocity(q, q, cmd, dt);
    }
    assertClose(
      Q.toHeadingPitchRoll(q).headingDeg,
      45,
      0.05,
      "yaw-right command increases heading",
    );

    const norm = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    assertClose(norm, 1, 1e-9, "attitude stays normalised");
  });

  suite("deterministic rng", () => {
    const a = createRng("ALPHA-1");
    const b = createRng("ALPHA-1");
    const c = createRng("ALPHA-2");
    const seqA = [a.next(), a.next(), a.next()];
    const seqB = [b.next(), b.next(), b.next()];
    const seqC = [c.next(), c.next(), c.next()];
    assert(
      seqA.every((v, i) => v === seqB[i]),
      "same seed produces the same sequence",
    );
    assert(
      seqA.some((v, i) => v !== seqC[i]),
      "different seeds diverge",
    );
    assert(
      seqA.every((v) => v >= 0 && v < 1),
      "values stay in [0, 1)",
    );
  });
}
