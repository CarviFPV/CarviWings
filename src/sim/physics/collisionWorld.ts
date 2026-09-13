/**
 * Physical interception detection, backed by Rapier.
 *
 * There are no weapons in this simulator. The only way to destroy an aircraft
 * is to hit it with another aircraft, so "did two aircraft touch" is the single
 * most gameplay-critical query in the whole project and it gets a real
 * collision engine rather than a hand-rolled distance check.
 *
 * Rapier is used strictly for collision detection. It never moves an aircraft:
 * the aerodynamic model in `flight/physics.ts` owns all motion, and each body
 * here is a kinematic proxy that is teleported to wherever the flight model put
 * it. Colliders are sensors so Rapier reports the overlap without applying an
 * impulse.
 *
 * The world is stepped once per *physics* substep rather than once per rendered
 * frame. At 240 Hz a head-on pass at 120 m/s advances 0.5 m per step, well
 * inside the combined collision radius, so two interceptors cannot tunnel
 * through each other.
 */

import type RAPIER from "@dimforge/rapier3d-compat";
import type { Vec3 } from "../math/vec3";

export interface CollisionEvent {
  readonly a: string;
  readonly b: string;
  /** Closing speed at the moment of contact, m/s. */
  readonly closingSpeed: number;
}

interface Body {
  readonly id: string;
  readonly rigidBody: RAPIER.RigidBody;
  readonly colliderHandle: number;
  readonly velocity: Vec3;
}

type RapierModule = typeof RAPIER;

let rapierModule: RapierModule | null = null;
let rapierLoad: Promise<RapierModule> | null = null;

/**
 * Loads and initialises Rapier exactly once. The `-compat` build carries its
 * WebAssembly inline, so this is a decompress-and-instantiate step rather than
 * a network fetch.
 */
export async function initRapier(): Promise<RapierModule> {
  if (rapierModule) return rapierModule;
  if (!rapierLoad) {
    rapierLoad = import("@dimforge/rapier3d-compat").then(async (module) => {
      await module.init();
      rapierModule = module.default ?? (module as unknown as RapierModule);
      return rapierModule;
    });
  }
  return rapierLoad;
}

export class CollisionWorld {
  private readonly rapier: RapierModule;
  private readonly world: RAPIER.World;
  private readonly queue: RAPIER.EventQueue;
  private readonly bodies = new Map<string, Body>();
  private readonly byCollider = new Map<number, Body>();
  private readonly pending: CollisionEvent[] = [];
  private readonly vector = { x: 0, y: 0, z: 0 };

  constructor(rapier: RapierModule) {
    this.rapier = rapier;
    // Zero gravity: the flight model already applies its own.
    this.world = new rapier.World({ x: 0, y: 0, z: 0 });
    this.queue = new rapier.EventQueue(true);
  }

  get bodyCount(): number {
    return this.bodies.size;
  }

  add(id: string, position: Vec3, radius: number): void {
    if (this.bodies.has(id)) this.remove(id);

    const bodyDesc = this.rapier.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(position.x, position.y, position.z)
      .setCcdEnabled(true);
    const rigidBody = this.world.createRigidBody(bodyDesc);

    const colliderDesc = this.rapier.ColliderDesc.ball(radius)
      .setSensor(true)
      .setActiveEvents(this.rapier.ActiveEvents.COLLISION_EVENTS)
      // Two aircraft are both kinematic proxies, and Rapier skips
      // kinematic-vs-kinematic pairs unless asked not to.
      .setActiveCollisionTypes(this.rapier.ActiveCollisionTypes.ALL);
    const collider = this.world.createCollider(colliderDesc, rigidBody);

    const body: Body = {
      id,
      rigidBody,
      colliderHandle: collider.handle,
      velocity: { x: 0, y: 0, z: 0 },
    };
    this.bodies.set(id, body);
    this.byCollider.set(collider.handle, body);
  }

  remove(id: string): void {
    const body = this.bodies.get(id);
    if (!body) return;
    this.byCollider.delete(body.colliderHandle);
    this.bodies.delete(id);
    this.world.removeRigidBody(body.rigidBody);
  }

  /** Teleports a proxy to wherever the flight model has put the aircraft. */
  sync(id: string, position: Vec3, velocity: Vec3): void {
    const body = this.bodies.get(id);
    if (!body) return;
    this.vector.x = position.x;
    this.vector.y = position.y;
    this.vector.z = position.z;
    body.rigidBody.setNextKinematicTranslation(this.vector);
    body.velocity.x = velocity.x;
    body.velocity.y = velocity.y;
    body.velocity.z = velocity.z;
  }

  /**
   * Advances the collision world and returns the interceptions that began this
   * step. The returned array is reused, so consume it before stepping again.
   */
  step(dt: number): readonly CollisionEvent[] {
    this.pending.length = 0;
    if (this.bodies.size < 2) return this.pending;

    this.world.timestep = dt;
    this.world.step(this.queue);

    this.queue.drainCollisionEvents((handleA, handleB, started) => {
      if (!started) return;
      const a = this.byCollider.get(handleA);
      const b = this.byCollider.get(handleB);
      if (!a || !b) return;
      const dx = a.velocity.x - b.velocity.x;
      const dy = a.velocity.y - b.velocity.y;
      const dz = a.velocity.z - b.velocity.z;
      this.pending.push({
        a: a.id,
        b: b.id,
        closingSpeed: Math.sqrt(dx * dx + dy * dy + dz * dz),
      });
    });

    return this.pending;
  }

  dispose(): void {
    this.bodies.clear();
    this.byCollider.clear();
    this.queue.free();
    this.world.free();
  }
}
