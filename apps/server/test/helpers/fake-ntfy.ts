import type { NtfySendInput, NtfySendOutcome, NtfyTransport } from '../../src/contracts';

export class FakeNtfyTransport implements NtfyTransport {
  readonly calls: NtfySendInput[] = [];
  outcome: NtfySendOutcome = { result: 'ok' };
  async send(input: NtfySendInput): Promise<NtfySendOutcome> {
    this.calls.push(input);
    return this.outcome;
  }
}
