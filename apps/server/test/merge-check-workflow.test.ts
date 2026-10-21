import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/** Rules of the public repository's merge-check workflow (PM-900): only an authorized dispatch runs it. */
const source = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/merge-check.yml', import.meta.url)),
  'utf8',
);
const workflow = parse(source) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    { if?: string; steps: { name?: string; uses?: string; run?: string; with?: Record<string, unknown> }[] }
  >;
};
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

describe('the merge-check workflow', () => {
  it('starts only from a dispatch, which needs write access', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  });

  it('can only read the repository and holds no secret', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(source).not.toContain('secrets.');
  });

  it('runs only on a check branch', () => {
    expect(Object.values(workflow.jobs).map((job) => job.if)).toEqual([
      "startsWith(github.ref, 'refs/heads/pm-check/')",
    ]);
  });

  it('never puts an expression into a command', () => {
    const commands = steps.flatMap((step) => (step.run ? [step.run] : []));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((command) => command.includes('${{'))).toEqual([]);
  });

  it('pins every action to a commit', () => {
    const actions = steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('leaves no credential in the checkout', () => {
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });

  it('has the step the engine follows', () => {
    expect(steps.some((step) => step.name === 'merge-test')).toBe(true);
  });

  it('installs Homebrew Bash on PATH before the tests run', () => {
    const install = steps.findIndex((step) => step.run?.includes('brew install bash'));
    const check = steps.findIndex((step) => step.name === 'merge-test');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(check);
    expect(steps[install]?.run).toContain('echo "$(brew --prefix bash)/bin" >> "$GITHUB_PATH"');
  });
});
