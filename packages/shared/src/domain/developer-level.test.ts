import { describe, expect, it } from 'vitest';
import { memberOf } from '../config/lookup';
import { ProjectConfig } from '../config/schema';
import { canSetDeveloperLevel, hasActiveSenior, seniorsOf, workStageOf } from '../config/senior';
import {
  DEFAULT_SENIOR_WAIT_MINUTES,
  developerLevelOf,
  developerLevelText,
  isSenior,
  seniorWaitMinutesOf,
  TaskDeveloperLevel,
} from './developer-level';
import { Task } from './task';

function configWith(overrides: { members?: Array<Record<string, unknown>>; limits?: object } = {}) {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
        { kind: 'human', handle: 'dev-human', displayName: 'Dev', access: 'developer', roles: [] },
        { kind: 'human', handle: 'po', displayName: 'PO', access: 'admin', roles: ['business_analyst'] },
        { kind: 'ai', handle: 'arch', displayName: 'Architect', role: 'architect', sponsor: 'owner' },
        { kind: 'ai', handle: 'dev-1', displayName: 'Dev 1', role: 'developer', sponsor: 'owner' },
        {
          kind: 'ai',
          handle: 'dev-2',
          displayName: 'Dev 2',
          role: 'developer',
          sponsor: 'owner',
          senior: true,
          onLeave: true,
        },
        { kind: 'ai', handle: 'cr', displayName: 'Reviewer', role: 'code_review', sponsor: 'owner' },
        ...(overrides.members ?? []),
      ],
      limits: overrides.limits ?? {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' },
        { id: 'dev', name: 'Dev', kind: 'work', owners: ['dev-1', 'dev-2', 'dev-human'], columnId: 'all' },
        { id: 'review', name: 'Review', kind: 'step', owners: ['cr', 'dev-2'], columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [],
    },
  });
}

describe('developer level', () => {
  it('reads a missing recommendation as any', () => {
    expect(developerLevelOf({})).toBe('any');
    const set = { level: 'senior' as const, reason: 'runner', setBy: 'arch', setAt: '2026-10-05T06:00:00Z' };
    expect(developerLevelOf({ developerLevel: set })).toBe('senior');
    expect(developerLevelOf({ developerLevel: { ...set, level: 'any', reason: null } })).toBe('any');
  });

  it('limits the reason to 300 characters', () => {
    const base = { level: 'senior', setBy: 'arch', setAt: 'now' };
    expect(TaskDeveloperLevel.safeParse({ ...base, reason: 'x'.repeat(300) }).success).toBe(true);
    expect(TaskDeveloperLevel.safeParse({ ...base, reason: 'x'.repeat(301) }).success).toBe(false);
  });

  it('writes the recommendation as one line', () => {
    expect(developerLevelText({ level: 'senior', reason: 'the runner\nand more' })).toBe(
      'senior (the runner and more)',
    );
    expect(developerLevelText({ level: 'any', reason: null })).toBe('any');
  });

  it('counts only an AI member marked senior that is no temp worker', () => {
    const config = configWith({
      members: [
        {
          kind: 'ai',
          handle: 'tmp',
          displayName: 'Tmp',
          role: 'developer',
          sponsor: 'owner',
          temp: true,
          senior: true,
        },
      ],
    });
    expect(isSenior(memberOf(config, 'dev-2'))).toBe(true);
    expect(isSenior(memberOf(config, 'dev-1'))).toBe(false);
    expect(isSenior(memberOf(config, 'tmp'))).toBe(false);
    expect(isSenior(memberOf(config, 'owner'))).toBe(false);
    expect(isSenior(undefined)).toBe(false);
  });

  it('finds the seniors among the owners of a stage, one on leave included', () => {
    const config = configWith();
    const stage = (id: string) => config.pipeline.stages.find((s) => s.id === id)!;
    expect(seniorsOf(config, stage('dev')).map((m) => m.handle)).toEqual(['dev-2']);
    expect(seniorsOf(config, stage('review')).map((m) => m.handle)).toEqual(['dev-2']);
    expect(seniorsOf(config, stage('ready'))).toEqual([]);
  });

  it('says whether the work stage of a card has a senior', () => {
    expect(hasActiveSenior(configWith(), { stageId: 'ready' })).toBe(true);
    expect(hasActiveSenior(configWith(), { stageId: 'dev' })).toBe(true);
    const without = configWith();
    const dev2 = memberOf(without, 'dev-2');
    if (dev2?.kind === 'ai') delete dev2.senior;
    expect(hasActiveSenior(without, { stageId: 'dev' })).toBe(false);
  });

  it('takes the stage a card is in as its work stage, else the first one', () => {
    const config = configWith();
    expect(workStageOf(config, { stageId: 'dev' })?.id).toBe('dev');
    expect(workStageOf(config, { stageId: 'review' })?.id).toBe('dev');
    expect(workStageOf({ pipeline: { ...config.pipeline, stages: [] } }, { stageId: 'dev' })).toBeUndefined();
  });

  it('lets an owner and the holders of the planning duties set it', () => {
    const config = configWith();
    expect(canSetDeveloperLevel(config, 'owner')).toBe(true);
    expect(canSetDeveloperLevel(config, 'arch')).toBe(true);
    expect(canSetDeveloperLevel(config, 'po')).toBe(true);
    expect(canSetDeveloperLevel(config, 'dev-1')).toBe(false);
    expect(canSetDeveloperLevel(config, 'dev-human')).toBe(false);
    expect(canSetDeveloperLevel(config, 'cr')).toBe(false);
    expect(canSetDeveloperLevel(config, 'stranger')).toBe(false);
  });

  it('waits 30 minutes unless the limits say otherwise', () => {
    expect(DEFAULT_SENIOR_WAIT_MINUTES).toBe(30);
    expect(seniorWaitMinutesOf(configWith().team.limits)).toBe(30);
    expect(seniorWaitMinutesOf(configWith({ limits: { seniorWaitMinutes: 90 } }).team.limits)).toBe(90);
  });

  it('keeps an old configuration without the new fields valid', () => {
    const old = configWith();
    expect(memberOf(old, 'dev-1')).not.toHaveProperty('senior');
    expect(old.team.limits.seniorWaitMinutes).toBeUndefined();
    expect(() => configWith({ limits: { seniorWaitMinutes: 4 } })).toThrow();
    expect(() => configWith({ limits: { seniorWaitMinutes: 1441 } })).toThrow();
  });

  it('keeps an old card without the field readable', () => {
    const old = {
      id: 'tsk_1',
      projectKey: 'AC',
      key: 'AC-1',
      title: 'Old',
      description: '',
      stageId: 'dev',
      status: 'active',
      assignee: null,
      repo: null,
      priority: null,
      labels: [],
      links: [],
      visibility: 'internal',
      createdBy: 'owner',
      createdAt: 'now',
      updatedAt: 'now',
      closedAt: null,
    };
    const parsed = Task.parse(old);
    expect(parsed.developerLevel).toBeUndefined();
    expect(developerLevelOf(parsed)).toBe('any');
  });
});
