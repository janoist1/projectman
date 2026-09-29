import type { ServerEvent } from '@projectman/shared';

/** In-process pub/sub that feeds the websocket broadcaster. */
export interface EventBus {
  publish(event: ServerEvent): void;
  subscribe(listener: (event: ServerEvent) => void): () => void;
}
