import type { FastifyBaseLogger } from 'fastify';
import type { ServerEvent } from '@projectman/shared';
import type { EventBus } from '../contracts';

/** Synchronous in-process pub/sub. A failing listener never breaks the publisher. */
export function createEventBus(logger?: FastifyBaseLogger): EventBus {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    publish(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (err) {
          logger?.error({ err, eventType: event.type }, 'event listener failed');
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
