import { relative } from 'node:path';
import type { Reporter } from 'vitest/reporters';

export const FILE_EVENT_PREFIX = 'merge-test file: ';
/** Set to `1` for the one run that should print the structured failure facts (the hand-over check, PM-1406). */
export const RUN_FACTS_VARIABLE = 'PROJECTMAN_TEST_RUN_FACTS';
export const RUN_FACTS_PREFIX = 'merge-test run facts: ';

const MESSAGE_MAX = 200;
const CAUSE_DEPTH = 3;
const ERRORS_PER_FAILURE_MAX = 5;

/** What a failure carries as plain data; the output text is never parsed for it. */
export interface ErrorFact {
  message: string;
  code?: string;
  syscall?: string;
  address?: string;
  path?: string;
}
/** A test's full name, a suite's name, or `(module)` for an error of the file itself. */
export interface FailedEntity {
  name: string;
  errors: ErrorFact[];
}
export interface FailedFile {
  /** The absolute module id. */
  file: string;
  failures: FailedEntity[];
}
export interface RunFacts {
  reason: 'passed' | 'failed' | 'interrupted';
  unhandled: ErrorFact[];
  failed: FailedFile[];
}

type TestRunEnd = NonNullable<Reporter['onTestRunEnd']>;
type Modules = Parameters<TestRunEnd>[0];
type SerializedErrors = Parameters<TestRunEnd>[1];
type ErrorLike = SerializedErrors[number];

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The error and its `cause` chain as facts: the first line of the message and the system error fields. */
function errorFacts(error: ErrorLike): ErrorFact[] {
  const facts: ErrorFact[] = [];
  let current: ErrorLike | undefined = error;
  for (let depth = 0; current && depth < CAUSE_DEPTH; depth++) {
    const fact: ErrorFact = { message: (text(current.message) ?? '').split('\n')[0]!.slice(0, MESSAGE_MAX) };
    for (const key of ['code', 'syscall', 'address', 'path'] as const) {
      const value = text(current[key]);
      if (value !== undefined) fact[key] = value;
    }
    facts.push(fact);
    current = current.cause;
  }
  return facts;
}

const entityFacts = (errors: readonly ErrorLike[]): ErrorFact[] =>
  errors.flatMap(errorFacts).slice(0, ERRORS_PER_FAILURE_MAX);

function failures(module: Modules[number]): FailedEntity[] {
  const found: FailedEntity[] = [];
  const moduleErrors = module.errors();
  if (moduleErrors.length) found.push({ name: '(module)', errors: entityFacts(moduleErrors) });
  for (const suite of module.children.allSuites()) {
    const errors = suite.errors();
    if (errors.length) found.push({ name: suite.fullName, errors: entityFacts(errors) });
  }
  for (const test of module.children.allTests()) {
    const result = test.result();
    if (result.state === 'failed') found.push({ name: test.fullName, errors: entityFacts(result.errors) });
  }
  return found;
}

/** Runs in Vitest's controller, including while a worker is collecting a file. */
export default class MergeTestReporter implements Reporter {
  onTestModuleQueued: Reporter['onTestModuleQueued'] = (module) => {
    this.report('start', module);
  };

  onTestModuleEnd: Reporter['onTestModuleEnd'] = (module) => {
    this.report('end', module);
  };

  /** Prints one facts line, only when the caller asked for it: the output is otherwise unchanged. */
  onTestRunEnd: TestRunEnd = (modules, unhandledErrors, reason) => {
    if (process.env[RUN_FACTS_VARIABLE] !== '1') return;
    const facts: RunFacts = {
      reason,
      unhandled: unhandledErrors.flatMap(errorFacts),
      failed: modules.flatMap((module) => {
        const list = failures(module);
        return list.length ? [{ file: module.moduleId, failures: list }] : [];
      }),
    };
    console.log(RUN_FACTS_PREFIX + JSON.stringify(facts));
  };

  private report(phase: 'start' | 'end', module: Parameters<NonNullable<Reporter['onTestModuleQueued']>>[0]) {
    console.log(
      FILE_EVENT_PREFIX +
        JSON.stringify({ phase, id: module.id, file: relative(process.cwd(), module.moduleId) }),
    );
  }
}
