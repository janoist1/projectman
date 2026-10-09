import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ChatItem } from '@projectman/shared';
import type { EngineId } from '@projectman/shared';
import type { PlanUsageProvider, TranscriptReader } from '../../contracts';
import { conflict } from '../../domain/errors';
import type { AgentProvider, PlanUsage } from '@projectman/shared';
import type { RemoteHub } from './hub';
import type { FileTransfers } from './transfers';

/**
 * The transcripts and the plan usage of the engine's machine (PM-315): the CLIs write them there. A
 * transcript read comes back as an uploaded JSON file (it can be large), the rest as small answers.
 */

const PLAN_USAGE_TTL_MS = 60_000;

export function createRemoteTranscripts(options: {
  hub: RemoteHub;
  transfers: FileTransfers;
  now?: () => number;
}): TranscriptReader {
  const { hub, transfers } = options;
  const engineFor = (engineId?: EngineId): EngineId | null => engineId ?? hub.defaultId();
  const usable = (engineId?: EngineId): EngineId | null => {
    const id = engineFor(engineId);
    return id && hub.available(id) ? id : null;
  };
  return {
    async hasContent(path, opts) {
      const id = usable(opts?.engineId);
      if (!id) return false;
      try {
        return await hub.call(id, 'transcript.has_content', {
          path,
          ...(opts?.confineTo === undefined ? {} : { confineTo: opts.confineTo }),
        });
      } catch {
        // An engine that cannot say is an engine that has no transcript to resume from.
        return false;
      }
    },
    async read(path, opts) {
      const id = usable(opts?.engineId);
      if (!id) throw conflict('engine_offline', 'the transcript is on an engine that is not connected');
      const ticket = transfers.issueUpload(id, 'transcript');
      try {
        const { provider, self, firstUserOrigin, cwd, confineTo } = opts ?? {};
        const receipt = await hub.call(id, 'transcript.read', {
          path,
          opts: {
            ...(provider === undefined ? {} : { provider }),
            ...(self === undefined ? {} : { self }),
            ...(firstUserOrigin === undefined ? {} : { firstUserOrigin }),
            ...(cwd === undefined ? {} : { cwd }),
            ...(confineTo === undefined ? {} : { confineTo }),
          },
          uploadToken: ticket.token,
        });
        const received = ticket.take(receipt);
        return z.array(ChatItem).parse(JSON.parse(await readFile(received.path, 'utf8')));
      } finally {
        ticket.dispose();
      }
    },
    async summary(path, opts) {
      const id = usable(opts.engineId);
      if (!id) return null;
      try {
        return await hub.call(id, 'transcript.summary', {
          path,
          provider: opts.provider,
          ...(opts.confineTo === undefined ? {} : { confineTo: opts.confineTo }),
        });
      } catch {
        return null;
      }
    },
  };
}

/** Plan usage of the default engine's accounts, asked at most once a minute per provider. */
export function createRemotePlanUsage(options: { hub: RemoteHub; now?: () => number }): {
  planUsage: PlanUsageProvider;
  planUsageFor: (provider: AgentProvider) => PlanUsageProvider;
} {
  const { hub } = options;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; usage: PlanUsage | null }>();
  const providerFor = (provider: AgentProvider): PlanUsageProvider => ({
    async get() {
      const id = hub.defaultId();
      if (!id || !hub.available(id)) return null;
      const key = `${id}\0${provider}`;
      const cached = cache.get(key);
      if (cached && now() - cached.at < PLAN_USAGE_TTL_MS) return cached.usage;
      try {
        const usage = await hub.call(id, 'usage.plan', { provider });
        cache.set(key, { at: now(), usage });
        return usage;
      } catch {
        return null;
      }
    },
  });
  return { planUsage: providerFor('claude'), planUsageFor: providerFor };
}
