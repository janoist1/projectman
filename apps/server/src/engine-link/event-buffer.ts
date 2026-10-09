import { EngineEvent, encodeFrame } from './protocol';
import type { EngineFrame } from './protocol';

/** Engine-side sequence and replay buffer. PTY data bypasses it and is never replayed. */
export function createEngineEventBuffer() {
  let nextSeq = 1;
  let ackedSeq = 0;
  let send: ((data: string) => void) | null = null;
  const buffered = new Map<number, Extract<EngineFrame, { t: 'evt' }>>();
  const acknowledge = (seq: number) => {
    if (!Number.isSafeInteger(seq) || seq < ackedSeq || seq >= nextSeq)
      throw new Error('Invalid event acknowledgement');
    ackedSeq = seq;
    for (const number of buffered.keys()) if (number <= seq) buffered.delete(number);
  };
  return {
    nextSeq: () => buffered.keys().next().value ?? nextSeq,
    ackedSeq: () => ackedSeq,
    pending: () => buffered.size,
    acknowledge,
    connect(sender: (data: string) => void, serverAck: number) {
      // Cloud state is in memory: a restart can report less than the engine already received.
      if (!Number.isSafeInteger(serverAck) || serverAck < 0 || serverAck >= nextSeq)
        throw new Error('Invalid event acknowledgement');
      if (serverAck >= ackedSeq) acknowledge(serverAck);
      send = sender;
      for (const frame of buffered.values()) send(encodeFrame(frame));
    },
    disconnect() {
      send = null;
    },
    emit(event: EngineEvent) {
      const frame = { t: 'evt', seq: nextSeq, event: EngineEvent.parse(event) } as const;
      // Validate size before consuming the sequence or retaining the event.
      const encoded = encodeFrame(frame);
      nextSeq += 1;
      buffered.set(frame.seq, frame);
      send?.(encoded);
    },
    terminal(sessionId: string, data: string) {
      send?.(encodeFrame({ t: 'term', sessionId, data }));
    },
  };
}
