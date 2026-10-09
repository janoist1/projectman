import { z } from 'zod';

/** The engine of a single-machine installation: the machine the server itself runs on. */
export const LOCAL_ENGINE_ID = 'local';

/**
 * Which engine (the machine the AI sessions run on, PM-311) something belongs to: `local`, or the id
 * of a registered engine. A session without one (a row from before engines) ran on `local`.
 */
export const EngineId = z.string().regex(/^(local|eng_[a-z0-9]{12})$/);
export type EngineId = z.infer<typeof EngineId>;
