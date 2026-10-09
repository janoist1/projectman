import { EngineEvent, encodeFrame } from './protocol';
import type { EngineFrame } from './protocol';

/** The most events, and encoded bytes, the engine keeps for the cloud while it is not connected (PM-314). */
export const ENGINE_BUFFER_MAX_EVENTS = 10_000;
export const ENGINE_BUFFER_MAX_BYTES = 50 * 1024 * 1024;

export interface EngineEventBufferOptions {
  maxEvents?: number;
  maxBytes?: number;
}

/**
 * Engine-side sequence and replay buffer. PTY data bypasses it and is never replayed. Past the
 * limits the oldest un-acknowledged events are dropped: `nextSeq()` then starts later than
 * `ackedSeq() + 1`, which the hello tells the cloud (it reconciles from a snapshot).
 */
export function createEngineEventBuffer(options: EngineEventBufferOptions = {}) {
  const maxEvents = options.maxEvents ?? ENGINE_BUFFER_MAX_EVENTS;
  const maxBytes = options.maxBytes ?? ENGINE_BUFFER_MAX_BYTES;
  let nextSeq = 1;
  let ackedSeq = 0;
  let bytes = 0;
  let dropped = 0;
  let send: ((data: string) => void) | null = null;
  const buffered = new Map<number, { frame: Extract<EngineFrame, { t: 'evt' }>; size: number }>();
  const release = (seq: number) => {
    const item = buffered.get(seq);
    if (!item) return;
    bytes -= item.size;
    buffered.delete(seq);
  };
  const acknowledge = (seq: number) => {
    if (!Number.isSafeInteger(seq) || seq < ackedSeq || seq >= nextSeq)
      throw new Error('Invalid event acknowledgement');
    ackedSeq = seq;
    for (const number of [...buffered.keys()]) if (number <= seq) release(number);
  };
  return {
    nextSeq: () => buffered.keys().next().value ?? nextSeq,
    ackedSeq: () => ackedSeq,
    pending: () => buffered.size,
    /** How many events were dropped because the limits were passed. */
    dropped: () => dropped,
    acknowledge,
    connect(sender: (data: string) => void, serverAck: number) {
      // Cloud state is in memory: a restart can report less than the engine already received.
      if (!Number.isSafeInteger(serverAck) || serverAck < 0 || serverAck >= nextSeq)
        throw new Error('Invalid event acknowledgement');
      if (serverAck >= ackedSeq) acknowledge(serverAck);
      send = sender;
      for (const { frame } of buffered.values()) send(encodeFrame(frame));
    },
    disconnect() {
      send = null;
    },
    emit(event: EngineEvent) {
      const frame = { t: 'evt', seq: nextSeq, event: EngineEvent.parse(event) } as const;
      // Validate size before consuming the sequence or retaining the event.
      const encoded = encodeFrame(frame);
      const size = Buffer.byteLength(encoded);
      nextSeq += 1;
      buffered.set(frame.seq, { frame, size });
      bytes += size;
      // The oldest first; the event just emitted is always kept.
      while (buffered.size > 1 && (buffered.size > maxEvents || bytes > maxBytes)) {
        release(buffered.keys().next().value!);
        dropped += 1;
      }
      send?.(encoded);
    },
    terminal(sessionId: string, data: string) {
      send?.(encodeFrame({ t: 'term', sessionId, data }));
    },
  };
}
