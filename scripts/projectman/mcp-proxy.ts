import { StringDecoder } from 'node:string_decoder';
import type { ClientCredentials } from './config';
import { readLimited } from './http';
import type { CliIo } from './io';
import { redact, safeMessage } from './redact';

const MAX_LINE_CHARS = 8 * 1024 * 1024;
/** JSON-RPC "server error" range: the proxy could not get an answer. */
const TRANSPORT_ERROR_CODE = -32000;

/**
 * `projectman mcp-proxy`: a transport shim between a local stdio MCP client and the server's bearer `/mcp`
 * endpoint (PM-760). One JSON line on standard input is one HTTP POST; the protocol messages of the answer
 * go to standard output, one per line. It does not read, change, choose or log what the messages say — a project
 * is chosen by the client's own tool calls — and it adds the secrets from its own files only. Standard output
 * carries protocol lines and nothing else; standard error carries redacted status lines without any body.
 */
export async function runMcpProxy(
  io: CliIo,
  credentials: ClientCredentials,
  options: { verbose: boolean },
): Promise<number> {
  const secrets = credentials.secrets;
  const url = new URL('/mcp', credentials.baseUrl);
  const log = (line: string) => io.stderr.write(`${redact(line, secrets)}\n`);
  let status = 0;

  const emit = (line: string): Promise<void> =>
    new Promise((resolve) => io.stdout.write(`${line}\n`, () => resolve()));

  /** What a waiting client gets when no answer can come: an error response for each request it sent. */
  const failure = (line: string, message: string): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return Promise.resolve();
    }
    const answers = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((item): item is { id: string | number } => {
        const id = (item as { id?: unknown } | null)?.id;
        return (typeof id === 'string' || typeof id === 'number') && 'method' in (item as object);
      })
      .map((item) => ({ jsonrpc: '2.0', id: item.id, error: { code: TRANSPORT_ERROR_CODE, message } }));
    return answers.reduce(
      (previous, answer) => previous.then(() => emit(JSON.stringify(answer))),
      Promise.resolve(),
    );
  };

  async function forward(line: string): Promise<void> {
    let response: Response;
    try {
      response = await io.fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: io.signal,
        headers: {
          authorization: `Bearer ${credentials.key}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...credentials.accessHeaders,
        },
        body: line,
      });
    } catch (error) {
      if (io.signal.aborted) return;
      log(`mcp-proxy: the request failed: ${safeMessage(error, secrets)}`);
      status = 1;
      return failure(line, 'projectman: the server could not be reached');
    }
    if (options.verbose) log(`mcp-proxy: POST /mcp -> ${response.status}`);
    if (response.status >= 300 && response.status < 400) {
      log(`mcp-proxy: the server answered with a redirect (${response.status}); redirects are not followed`);
      status = 1;
      return failure(line, 'projectman: the server redirected the request');
    }
    let body: string;
    try {
      body = await readLimited(response);
    } catch (error) {
      log(`mcp-proxy: the answer could not be read: ${safeMessage(error, secrets)}`);
      status = 1;
      return failure(line, 'projectman: the answer could not be read');
    }
    if (!response.ok) {
      const code = errorCodeOf(body);
      log(`mcp-proxy: the server refused the request (HTTP ${response.status}${code ? `, ${code}` : ''})`);
      if (response.status === 401) status = 3;
      else status ||= 1;
      return failure(
        line,
        `projectman: the server refused the request (HTTP ${response.status}${code ? `, ${code}` : ''})`,
      );
    }
    if (body.trim() === '') return; // a notification: the server answers with nothing
    const type = response.headers.get('content-type') ?? '';
    const messages = type.includes('text/event-stream') ? sseMessages(body) : [body];
    for (const message of messages) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch {
        log('mcp-proxy: the server sent something that is not a protocol message');
        status = 1;
        return failure(line, 'projectman: the server sent an invalid message');
      }
      await emit(JSON.stringify(parsed));
    }
  }

  const pending = new Set<Promise<void>>();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const dispatch = (text: string) => {
    if (text.trim() === '') return;
    const task = forward(text).finally(() => pending.delete(task));
    pending.add(task);
  };
  // A signal must end the proxy even while standard input is open and silent, so the wait for the next
  // chunk is raced against the abort instead of left to `for await`.
  const stop = abortSignalPromise(io.signal);
  const input = io.stdin[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await Promise.race([input.next(), stop.promise]);
      if (next === ABORTED) {
        // Do not wait for the reader to settle: a pending read on a silent pipe never does.
        void Promise.resolve(input.return?.()).catch(() => undefined);
        return status;
      }
      if (next.done) break;
      const chunk = next.value;
      buffer += typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk));
      if (buffer.length > MAX_LINE_CHARS) {
        log('mcp-proxy: a line on standard input is too long');
        return 1;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        dispatch(buffer.slice(0, newline).replace(/\r$/, ''));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.end();
    dispatch(buffer);
  } finally {
    stop.dispose();
    await Promise.allSettled([...pending]);
  }
  return status;
}

const ABORTED = Symbol('aborted');

/** Resolves with `ABORTED` when the signal aborts; `dispose` removes the listener. */
function abortSignalPromise(signal: AbortSignal): { promise: Promise<typeof ABORTED>; dispose(): void } {
  let listener: (() => void) | undefined;
  const promise = new Promise<typeof ABORTED>((resolve) => {
    if (signal.aborted) return resolve(ABORTED);
    listener = () => resolve(ABORTED);
    signal.addEventListener('abort', listener, { once: true });
  });
  return { promise, dispose: () => listener && signal.removeEventListener('abort', listener) };
}

function errorCodeOf(body: string): string | null {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/** The `data:` payloads of a server-sent-event body, one per event. */
function sseMessages(body: string): string[] {
  const messages: string[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((row) => row.startsWith('data:'))
      .map((row) => row.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data !== '') messages.push(data);
  }
  return messages;
}
