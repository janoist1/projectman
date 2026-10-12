import { CloudError } from './errors';

/** One line per step: `<status> <step>[: <detail>]`, or `FAIL <step>: <reason>`. */
export type StepStatus = 'ok' | 'created' | 'updated' | 'unchanged' | 'skipped';

export interface StepResult {
  status: StepStatus;
  detail?: string;
}

/** Secrets shorter than this are not worth masking (and would mask ordinary words). */
const MIN_SECRET_LENGTH = 8;

export class Report {
  private readonly emit: (line: string) => void;
  private readonly secrets = new Set<string>();

  constructor(emit: (line: string) => void) {
    this.emit = emit;
  }

  /**
   * Last line of defence: a value registered here is masked in everything printed. The commands never put a
   * secret in a message; this only guards against a tool echoing one back.
   */
  protect(secret: string): void {
    if (secret.length >= MIN_SECRET_LENGTH) this.secrets.add(secret);
  }

  line(text: string): void {
    let safe = text;
    for (const secret of this.secrets) safe = safe.split(secret).join('***');
    this.emit(safe);
  }

  step(status: StepStatus, step: string, detail?: string): void {
    this.line(detail ? `${status} ${step}: ${detail}` : `${status} ${step}`);
  }

  /** Runs one step and prints its line (a step may print its own lines and return nothing). */
  async run(step: string, body: () => Promise<StepResult | void>): Promise<void> {
    await this.guard(step, async () => {
      const result = await body();
      if (result) this.step(result.status, step, result.detail);
    });
  }

  /** Runs a body; a failure prints `FAIL <step>: <reason>` and is rethrown (already reported). */
  async guard<T>(step: string, body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      const failure = error instanceof CloudError ? error : new CloudError(describe(error), 1);
      if (!failure.reported) {
        this.line(`FAIL ${step}: ${failure.message}`);
        failure.reported = true;
      }
      throw failure;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
