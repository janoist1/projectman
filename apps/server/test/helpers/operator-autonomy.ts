/**
 * A switch for `operatorAutonomousLevel` (decision 55, PM-888). An owner-asked configuration change now goes
 * straight through, so the tests of the approval item's own mechanics (stale rows, races, restarts, the
 * waiver) turn it off: with it off, the verdict's level decides, as before. A test of the autonomous path
 * turns it on. Use as
 *
 *   vi.mock('@projectman/shared', async (original) =>
 *     (await import('./helpers/operator-autonomy')).switchable(await original()));
 */
export const autonomy = { on: false };

export function switchable<T extends { operatorAutonomousLevel: (...args: never[]) => unknown }>(
  shared: T,
): T {
  const real = shared.operatorAutonomousLevel as (...args: unknown[]) => unknown;
  return {
    ...shared,
    operatorAutonomousLevel: (...args: unknown[]) =>
      autonomy.on ? real(...args) : (args[2] as { level: unknown }).level,
  };
}
