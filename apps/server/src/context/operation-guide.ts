import { OperatorOperation, SuperCommand } from '@projectman/shared';
import { z } from 'zod';

/** Noise the model does not need: the dialect URL and the "no other keys" flag of every object. */
const NOISE = new Set(['$schema', 'additionalProperties']);

function render(title: string, key: string, options: readonly z.ZodObject[]): string {
  return [
    `## ${title}`,
    ...options.map((option) => {
      const tag = (option.shape[key] as z.ZodLiteral<string>).value;
      const json = z.toJSONSchema(option, { io: 'input', unrepresentable: 'any' });
      return `- ${key}=${tag}: ${JSON.stringify(json, (name, value: unknown) => (NOISE.has(name) ? undefined : value))}`;
    }),
  ].join('\n');
}

/**
 * The `operations` guide of the Operator: the fields of every `operate` operation and every
 * `execute_operation` command, generated from the schemas the server validates with, so the
 * rule lives in one place (PM-1034).
 */
export function operationsGuide(): string {
  return [
    '# Operations guide',
    'The tool inputs name only the kind (`operation.op`, `command.kind`); the server validates the rest against the schemas below (JSON Schema of the input) and refuses with the path of the faulty field.',
    render('operate: operation', 'op', OperatorOperation.options),
    render('execute_operation: command', 'kind', SuperCommand.options),
  ].join('\n\n');
}
