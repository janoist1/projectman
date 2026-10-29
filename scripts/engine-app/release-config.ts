import { z } from 'zod';

export const EngineAppReleaseConfig = z.strictObject({
  version: z.literal(1),
  signingIdentity: z.string().min(1),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/),
  notaryProfile: z.string().min(1),
});
