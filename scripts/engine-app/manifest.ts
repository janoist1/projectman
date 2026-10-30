import { z } from 'zod';
import { RELEASE_TAG_PATTERN } from '@projectman/shared';

const asset = (name: string) =>
  z.strictObject({
    name: z.literal(name),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().positive(),
  });

/** Shared wire format with the native app updater (PM-1104). Empty teamId disables updates. */
export const EngineAppManifest = z.strictObject({
  schemaVersion: z.literal(1),
  tag: z.string().regex(RELEASE_TAG_PATTERN).nullable(),
  version: z.string().regex(/^[0-9a-f]{40}$/),
  bundleVersion: z.string().regex(/^(0|\d{8}\.\d+)$/),
  minimumMacOS: z.literal('13.0'),
  arch: z.literal('arm64'),
  teamId: z.string().regex(/^([A-Z0-9]{10})?$/),
  zip: asset('projectman-motor.zip'),
  dmg: asset('projectman-motor.dmg'),
});

export type EngineAppManifest = z.infer<typeof EngineAppManifest>;

export function bundleVersions(tag: string | null): { short: string; build: string } {
  if (tag === null) return { short: '0.0.0', build: '0' };
  if (!RELEASE_TAG_PATTERN.test(tag)) throw new Error('Invalid release tag');
  const [year, month, day, sequence = '0'] = tag.slice(1).split('.');
  const date = new Date(`${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  )
    throw new Error('Invalid release date');
  return {
    short: tag.slice(1),
    build: `${year}${month!.padStart(2, '0')}${day!.padStart(2, '0')}.${sequence}`,
  };
}
