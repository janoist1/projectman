import path from 'node:path';
import { modelForProvider } from '@projectman/shared';
import type { StartSessionSpec } from '../../../contracts';

export const GEMINI_FAMILY_EFFORTS: Record<string, readonly string[]> = {
  'gemini-3.8-flash': ['low', 'medium', 'high'],
  'gemini-3.7-flash': ['low', 'medium', 'high'],
  'gemini-3.6-flash': ['low', 'medium', 'high'],
  'gemini-3.1-pro': ['low', 'high'],
};

export function buildGeminiArgs(spec: StartSessionSpec, dir: string): string[] {
  if (!spec.policy) throw new Error('Gemini requires a session policy.');
  if (spec.policy.enforcement === 'strict')
    throw new Error('Strict Gemini sandbox enforcement is unavailable; refusing to start.');
  const args = [
    '--gemini_dir',
    dir,
    '--log-file',
    path.join(dir, 'agy.log'),
    '--release_base_url',
    'http://127.0.0.1:9',
  ];
  const model = modelForProvider('gemini', spec.model);
  args.push('--model', model);
  if (!/-(low|medium|high)$/i.test(model)) {
    let effort: string =
      spec.effort === 'max' || spec.effort === 'xhigh' ? 'high' : (spec.effort ?? 'medium');
    const family = GEMINI_FAMILY_EFFORTS[model.toLowerCase()];
    if (family && !family.includes(effort))
      effort =
        family.find(
          (e) => ['low', 'medium', 'high'].indexOf(e) >= ['low', 'medium', 'high'].indexOf(effort),
        ) ?? 'high';
    args.push('--effort', effort);
  }
  if (spec.permissionMode === 'plan') args.push('--mode', 'plan');
  for (const dir of spec.additionalDirectories ?? []) args.push('--add-dir', dir);
  if (spec.resume) args.push('--conversation', spec.claudeSessionId);
  return args;
}
