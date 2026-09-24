/**
 * Epoch for in-flight component reads. A flight records the epoch at start.
 * A later read must not join that flight if the key was written or invalidated
 * after the flight started (read-your-own-write).
 *
 * Per-key increments stay cheap. Bulk invalidation that has no type ids bumps
 * a generation mixed into every key's epoch.
 */

const keyEpoch = new Map<string, number>();
let generation = 0;

function flightKey(entityId: string, typeId: string): string {
  return `${entityId}\0${typeId}`;
}

export function componentReadEpoch(entityId: string, typeId: string): number {
  return generation + (keyEpoch.get(flightKey(entityId, typeId)) ?? 0);
}

export function bumpComponentReadFlight(entityId: string, typeId: string): void {
  const key = flightKey(entityId, typeId);
  keyEpoch.set(key, (keyEpoch.get(key) ?? 0) + 1);
}

export function bumpAllComponentReadFlights(): void {
  generation += 1;
}
