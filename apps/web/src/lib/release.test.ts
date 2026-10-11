import { describe, expect, it } from 'vitest';
import type { ReleaseStep } from '@projectman/shared';
import { t } from '../i18n/t';
import {
  isHttpsUrl,
  releaseChangesUrl,
  releaseFailedWords,
  releaseGithub,
  releaseOutcome,
  releaseStepName,
} from './release';

const repos = [
  { name: 'webshop', path: 'webshop', github: 'acme/webshop', defaultBranch: 'main' },
  { name: 'local', path: 'local', defaultBranch: 'main' },
];
const config = (list: typeof repos) => ({ project: { repos: list } }) as never;

describe('the outcome of a failed release (PM-492)', () => {
  it('changes nothing before the deploy stops the live system', () => {
    for (const step of ['fetch', 'build', 'test', 'config_check', 'pause'] as const)
      expect(releaseOutcome(step, false)).toBe('early');
  });

  it('is rolled back or down from the stop step on, by the rollback flag', () => {
    for (const step of ['stop', 'backup', 'switch', 'verify', 'rollback'] as const) {
      expect(releaseOutcome(step, true)).toBe('rolledBack');
      expect(releaseOutcome(step, false)).toBe('down');
    }
  });

  it('treats the publish step as its own case', () => {
    expect(releaseOutcome('publish', false)).toBe('publish');
    expect(releaseOutcome('publish', true)).toBe('publish');
  });

  it('names every step in Hungarian', () => {
    const steps: ReleaseStep[] = [
      'fetch',
      'build',
      'test',
      'config_check',
      'pause',
      'stop',
      'backup',
      'switch',
      'verify',
      'rollback',
      'publish',
    ];
    for (const step of steps) expect(releaseStepName(step)).not.toContain('release.steps');
  });

  it('puts the step and the card key into the alert words', () => {
    const early = releaseFailedWords('build', false, 'PM-9');
    expect(early.title).toBe(t('inbox.alerts.release_failed.title', { key: 'PM-9' }));
    expect(early.what).toContain(releaseStepName('build'));
    const down = releaseFailedWords('switch', false, 'PM-9');
    expect(down.title).toBe(t('inbox.alerts.release_failed.titleDown', { key: 'PM-9' }));
    expect(down.what).toContain(releaseStepName('switch'));
    const rolled = releaseFailedWords('verify', true, 'PM-9');
    expect(rolled.what).toBe(
      t('inbox.alerts.release_failed.rolledBack', { step: releaseStepName('verify') }),
    );
  });
});

describe('the GitHub address of a release (PM-492)', () => {
  it('uses the card repository, else the only repository of the project', () => {
    expect(releaseGithub(config(repos), 'webshop')).toBe('acme/webshop');
    expect(releaseGithub(config([repos[0]!]), null)).toBe('acme/webshop');
  });

  it('gives no address when it is unclear or the repository is not on GitHub', () => {
    expect(releaseGithub(config(repos), null)).toBeNull();
    expect(releaseGithub(config(repos), 'local')).toBeNull();
    expect(releaseGithub(undefined, 'webshop')).toBeNull();
  });

  it('links the comparison with the last live version, or the commit alone', () => {
    expect(releaseChangesUrl('acme/webshop', 'bbb', 'aaa')).toBe(
      'https://github.com/acme/webshop/compare/aaa...bbb',
    );
    expect(releaseChangesUrl('acme/webshop', 'bbb', null)).toBe('https://github.com/acme/webshop/commit/bbb');
  });

  it('accepts only https addresses', () => {
    expect(isHttpsUrl('https://github.com/a/b')).toBe(true);
    expect(isHttpsUrl('http://github.com/a/b')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl(undefined)).toBe(false);
  });
});
