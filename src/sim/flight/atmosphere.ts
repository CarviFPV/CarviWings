/** International Standard Atmosphere helpers. */

/** Sea-level density, kg/m^3. */
export const SEA_LEVEL_DENSITY = 1.225;

/**
 * ISA air density at a geometric altitude in metres.
 *
 * This matters for gameplay, not just realism: the Swiss Alps and Rocky
 * Mountains presets start above 2000 m, where a wing needs noticeably more
 * airspeed for the same lift.
 */
export function airDensity(altitudeMetres: number): number {
  if (altitudeMetres <= 0) return SEA_LEVEL_DENSITY;
  if (altitudeMetres > 20000) return 0.088;
  return SEA_LEVEL_DENSITY * Math.pow(1 - 2.25577e-5 * altitudeMetres, 4.25588);
}
