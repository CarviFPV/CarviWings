/**
 * Normalised flight input.
 *
 * Everything that can fly an aircraft — keyboard, gamepad, RC transmitter or
 * the enemy AI — produces this structure and nothing else. The flight model
 * has no idea which of them is at the controls.
 */
export interface FlightInput {
  /** -1 = full nose down, +1 = full nose up. */
  pitch: number;
  /** -1 = full roll left, +1 = full roll right. */
  roll: number;
  /** -1 = full yaw left, +1 = full yaw right. */
  yaw: number;
  /** 0 = idle, 1 = full power. */
  throttle: number;
}

export function createFlightInput(): FlightInput {
  return { pitch: 0, roll: 0, yaw: 0, throttle: 0 };
}
