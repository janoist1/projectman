import type { PushSendInput, PushSendOutcome, PushTransport } from '../../src/contracts';

export class FakePushTransport implements PushTransport {
  readonly calls: PushSendInput[] = [];
  outcome: PushSendOutcome = { result: 'ok' };
  async send(input: PushSendInput): Promise<PushSendOutcome> {
    this.calls.push(input);
    return this.outcome;
  }
}
