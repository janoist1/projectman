import {
  ControlResponse,
  MAX_CONTROL_REQUEST_BYTES,
  MAX_CONTROL_RESPONSE_BYTES,
  parseControlRequestInput,
} from '@projectman/shared';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';
import { withHost } from './host';

/** The machine relay answers within the client's own 30 s; the rest is the connection through SSH/SSM. */
const RELAY_TIMEOUT_MS = 90_000;

/** Reads the whole input, but never more than one byte over the limit: that byte is enough to refuse it. */
async function readRequest(stdin: AsyncIterable<Uint8Array> | undefined): Promise<Uint8Array> {
  if (!stdin) throw refused('release-control reads its request from the standard input');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_CONTROL_REQUEST_BYTES) break;
  }
  return Buffer.concat(chunks);
}

/** The relay's answer: one line of at most 64 KiB that is a `ControlResponse`. */
function parseAnswer(stdout: string): string {
  const bytes = Buffer.byteLength(stdout);
  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  if (bytes > MAX_CONTROL_RESPONSE_BYTES + 1 || !body || body.includes('\n'))
    throw new CloudError('the machine answered release-control with something that is not one response line');
  try {
    // Re-serialised from the parsed value: only the contract's fields leave this command.
    return JSON.stringify(ControlResponse.parse(JSON.parse(body)));
  } catch {
    throw new CloudError('the machine answered release-control in an unexpected shape');
  }
}

/**
 * `npm run cloud -- release-control` (PM-749): one control request from the standard input to the board's
 * local control socket, through the verified SSH-over-SSM session and the fixed relay command on the
 * machine. Only the response JSON line goes to the standard output (the report goes to the standard error).
 * A domain refusal (`ok: false`) is a response and exits 0; the request is never sent twice.
 */
export async function runReleaseControl(context: CloudContext): Promise<void> {
  const input = parseControlRequestInput(await readRequest(context.deps.stdin));
  if (!input.ok) throw refused(input.reason);
  if (input.request.op.startsWith('release_') && !context.config.releaseTarget)
    throw refused('the configuration has no releaseTarget, so this board does not release');
  const stdout = await withHost(context, (host) =>
    host.call('release-control', [], { input: `${input.line}\n`, timeoutMs: RELAY_TIMEOUT_MS }),
  );
  context.deps.out(parseAnswer(stdout));
}
