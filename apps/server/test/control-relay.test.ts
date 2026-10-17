import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_CONTROL_REQUEST_BYTES } from '@projectman/shared';
import { RELAY_EXIT, runControlRelay } from '../src/control';

// The input side of the admin channel (PM-749). The relay's answers over a real Unix socket are in
// control-relay.integration.test.ts: the agent sandbox cannot bind one.

async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === 'string' ? Buffer.from(part) : part;
}

async function relay(
  input: AsyncIterable<Uint8Array>,
  argv: string[] = [join('/nonexistent', 'control.sock')],
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runControlRelay(argv, {
    stdin: input,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

describe('the control relay input', () => {
  const refusals: [string, AsyncIterable<Uint8Array>][] = [
    ['an empty input', chunks()],
    ['no newline', chunks('{"op":"status"}')],
    ['two requests', chunks('{"op":"status"}\n{"op":"status"}\n')],
    ['text after the newline', chunks('{"op":"status"}\n\n')],
    ['an empty line', chunks('\n')],
    ['broken JSON', chunks('{"op":\n')],
    ['an unknown op', chunks('{"op":"release_approve","releaseId":"rel_1"}\n')],
    ['an approval op', chunks('{"op":"propose","title":"x"}\n')],
    ['a request with a missing field', chunks('{"op":"release_claim","releaseId":"rel_1"}\n')],
    ['a command line', chunks('docker exec evil sh\n')],
    ['bytes that are not UTF-8', chunks(Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]))],
    ['an input over 16 KiB', chunks(`{"op":"pause","reason":"${'x'.repeat(MAX_CONTROL_REQUEST_BYTES)}"}\n`)],
    ['a long stream', chunks(...Array.from({ length: 40 }, () => 'x'.repeat(1024)))],
  ];

  it.each(refusals)('refuses %s with status 2, without echoing it', async (_name, input) => {
    const result = await relay(input);
    expect(result.code).toBe(RELAY_EXIT.refused);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^refused: /);
    expect(result.stderr).not.toContain('evil');
    expect(result.stderr).not.toContain('release_approve');
  });

  it('takes a request line of exactly the limit and refuses one byte more', async () => {
    const overhead = Buffer.byteLength('{"op":"release_get","releaseId":""}\n');
    const line = (bytes: number) => `{"op":"release_get","releaseId":"${'a'.repeat(bytes - overhead)}"}\n`;
    // Within the limit it is a request: it fails only at the missing socket (transport, status 1).
    expect((await relay(chunks(line(MAX_CONTROL_REQUEST_BYTES)))).code).toBe(RELAY_EXIT.transport);
    const over = await relay(chunks(line(MAX_CONTROL_REQUEST_BYTES + 1)));
    expect(over.code).toBe(RELAY_EXIT.refused);
    expect(over.stderr).toContain('longer than 16 KiB');
  });

  it('is told its one argument only', async () => {
    for (const argv of [[], ['/a', '/b'], ['']]) {
      const result = await relay(chunks('{"op":"status"}\n'), argv);
      expect(result.code).toBe(RELAY_EXIT.usage);
      expect(result.stdout).toBe('');
    }
  });

  it('fails the transport with status 1 when nobody answers, and prints nothing on stdout', async () => {
    const result = await relay(chunks('{"op":"status"}\n'));
    expect(result).toMatchObject({ code: RELAY_EXIT.transport, stdout: '' });
    expect(result.stderr).toContain('unreachable');
  });
});
