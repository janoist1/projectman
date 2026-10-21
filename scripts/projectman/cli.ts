import { parseArgs } from 'node:util';
import { CLIENT_EXIT } from '@projectman/shared';
import { COMMANDS, type CommandSpec } from './commands';
import { ClientConfigError, loadCredentials, type ClientCredentials } from './config';
import { type CommandContext, UsageError } from './context';
import { OutputClosedError } from './events';
import { ClientFileError } from './files';
import { ApiError, createApiClient } from './http';
import type { CliIo } from './io';
import { runMcpProxy } from './mcp-proxy';
import { redact, safeMessage } from './redact';

const HELP_OPTIONS = {
  json: { type: 'boolean' },
  config: { type: 'string' },
  verbose: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

export function usageText(): string {
  const rows = COMMANDS.map((command) => `  projectman ${command.usage.padEnd(76)} ${command.summary}`);
  return [
    'usage: projectman <command> [options]',
    '',
    ...rows,
    '  projectman mcp-proxy                                                         A stdio MCP shim to the server /mcp endpoint',
    '',
    'common options: --json (the typed answer as JSON), --config FILE (default ~/.config/projectman/client.json), --verbose',
    'writes take --request-id UUID to repeat the same call safely; a write whose outcome is unknown is never repeated by itself',
    'exit status: 0 done, 1 the operation failed, 2 wrong usage, 3 authentication or credential file problem',
    '',
  ].join('\n');
}

function find(argv: string[]): { command: CommandSpec; rest: string[] } | null {
  for (const command of COMMANDS) {
    const words = command.name.split(' ');
    if (words.every((word, index) => argv[index] === word))
      return { command, rest: argv.slice(words.length) };
  }
  return null;
}

/**
 * The client. Returns the exit status: 0 done, 1 the operation failed, 2 wrong usage, 3 authentication or a
 * credential file. Nothing it writes carries the key or the Access values (`redact`), and it reads no secret from
 * an argument or an environment variable.
 */
export async function main(argv: string[], io: CliIo): Promise<number> {
  const out = (text: string) => io.stderr.write(text);
  const [first] = argv;
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    out(usageText());
    return first === undefined ? CLIENT_EXIT.usage : CLIENT_EXIT.ok;
  }

  let secrets: string[] = [];
  try {
    if (first === 'mcp-proxy') {
      const parsed = parseArgs({
        args: argv.slice(1),
        options: HELP_OPTIONS,
        allowPositionals: false,
        strict: true,
      });
      if (parsed.values.help) {
        out(usageText());
        return CLIENT_EXIT.ok;
      }
      const credentials = loadCredentials({ home: io.home, configFile: parsed.values.config });
      return await runMcpProxy(io, credentials, { verbose: parsed.values.verbose === true });
    }

    const found = find(argv);
    if (!found) throw new UsageError(`unknown command: ${argv.slice(0, 2).join(' ')}`);
    const { command } = found;
    const parsed = parseArgs({
      args: found.rest,
      options: command.options,
      allowPositionals: true,
      strict: true,
    });
    if (parsed.values.help) {
      out(`usage: projectman ${command.usage}\n${command.summary}\n`);
      return CLIENT_EXIT.ok;
    }
    const count = parsed.positionals.length;
    if (command.positionals === 'rest' ? count === 0 : count !== command.positionals)
      throw new UsageError(`usage: projectman ${command.usage}`);

    // The credential files are read when the command first needs them, so a wrong argument is a usage error
    // (status 2) even when the configuration is wrong too.
    const verbose = parsed.values.verbose === true;
    let loaded: ClientCredentials | undefined;
    let client: ReturnType<typeof createApiClient> | undefined;
    const credentialsOf = (): ClientCredentials => {
      if (!loaded) {
        loaded = loadCredentials({ home: io.home, configFile: parsed.values.config as string | undefined });
        secrets = loaded.secrets;
      }
      return loaded;
    };
    const context: CommandContext = {
      io,
      get credentials() {
        return credentialsOf();
      },
      get api() {
        client ??= createApiClient({
          credentials: credentialsOf(),
          fetch: io.fetch,
          verbose: verbose ? (line) => out(`${line}\n`) : undefined,
        });
        return client;
      },
      json: parsed.values.json === true,
      values: parsed.values as CommandContext['values'],
      positionals: parsed.positionals,
      print: (text) =>
        new Promise((resolve, reject) =>
          io.stdout.write(text, (error) =>
            error ? reject(new OutputClosedError('standard output is closed')) : resolve(),
          ),
        ),
      note: (text) => out(`${redact(text, secrets)}\n`),
    };
    return await command.run(context);
  } catch (error) {
    return report(error, secrets, io, first);
  }
}

function report(error: unknown, secrets: string[], io: CliIo, first: string): number {
  const line = (text: string) => io.stderr.write(`projectman: ${redact(text, secrets)}\n`);
  if (error instanceof UsageError) {
    line(error.message);
    return CLIENT_EXIT.usage;
  }
  if (
    error instanceof Error &&
    error.name === 'TypeError' &&
    'code' in error &&
    String((error as { code: unknown }).code).startsWith('ERR_PARSE_ARGS')
  ) {
    line(error.message);
    io.stderr.write(`try: projectman --help\n`);
    return CLIENT_EXIT.usage;
  }
  if (error instanceof ClientConfigError || error instanceof ClientFileError) {
    line(`${error.message} [${error.code}]`);
    return CLIENT_EXIT.auth;
  }
  if (error instanceof ApiError) {
    if (error.status === 403 && error.code === 'operator_grant_inactive') {
      line('super grant is not active: ask the owner to grant it in Settings › Operator');
      return CLIENT_EXIT.auth;
    }
    line(`${error.message} [${error.code}]`);
    if (error.uncertain)
      line(
        `the outcome of this change is unknown${error.requestId ? ` (request id ${error.requestId})` : ''}; read the state before you repeat it. ` +
          'A super operation can be repeated with the same --request-id: the server runs it once.',
      );
    return error.kind === 'auth' ? CLIENT_EXIT.auth : CLIENT_EXIT.failed;
  }
  if (error instanceof OutputClosedError) {
    line(error.message);
    return CLIENT_EXIT.failed;
  }
  if (io.signal.aborted && first !== undefined) return CLIENT_EXIT.ok;
  line(`unexpected error: ${safeMessage(error, secrets)}`);
  return CLIENT_EXIT.failed;
}
