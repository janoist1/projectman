import type { ClientCredentials } from './config';
import type { ApiClient } from './http';
import type { CliIo } from './io';

/** Wrong command line: answered with exit status 2 and the usage text. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface CommandContext {
  io: CliIo;
  api: ApiClient;
  credentials: ClientCredentials;
  json: boolean;
  values: Record<string, string | string[] | boolean | undefined>;
  positionals: string[];
  /** Writes to standard output and waits until it has been written. */
  print(text: string): Promise<void>;
  /** A line for the user on the error stream, redacted. */
  note(text: string): void;
}
