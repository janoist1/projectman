/** Types of `vitest-places.mjs`, for the vitest configs: structural, so a config's type check stays out of the server's types. */

/** The vitest plugin that takes a run's places (and so its workers) from the machine's pool. */
export function machinePlaces(): {
  name: string;
  configureVitest(context: { vitest: unknown }): Promise<void>;
};
