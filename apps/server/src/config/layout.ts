import { parse, stringify } from 'yaml';
import type { ProjectConfig } from '@projectman/shared';
import { ConfigStoreError } from './errors';

/**
 * File layout of one project in the customization repository:
 *   projects/<KEY>/project.yaml   schemaVersion, project, team.limits
 *   projects/<KEY>/team.yaml      members, custom roles
 *   projects/<KEY>/pipeline.yaml  columns, stages
 */
export const PROJECT_FILES = ['project.yaml', 'team.yaml', 'pipeline.yaml'] as const;
export type ProjectFileName = (typeof PROJECT_FILES)[number];

const HEADER = '# Managed by projectman. Every change is a commit in this repository.\n';

export function splitProjectConfig(config: ProjectConfig): Record<ProjectFileName, string> {
  const yaml = (value: unknown) => HEADER + stringify(value, { lineWidth: 0 });
  return {
    'project.yaml': yaml({
      schemaVersion: config.schemaVersion,
      project: config.project,
      team: { limits: config.team.limits },
    }),
    'team.yaml': yaml({ members: config.team.members, roles: config.team.roles }),
    'pipeline.yaml': yaml({ columns: config.pipeline.columns, stages: config.pipeline.stages }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseYamlFile(file: string, text: string): unknown {
  try {
    return parse(text);
  } catch (err) {
    throw new ConfigStoreError('invalid_yaml', `${file}: ${(err as Error).message}`, { file });
  }
}

/** Merges the parsed files back into one (not yet validated) configuration object. */
export function mergeProjectFiles(files: Record<ProjectFileName, unknown>): unknown {
  const project = asRecord(files['project.yaml']);
  const team = asRecord(files['team.yaml']);
  const pipeline = asRecord(files['pipeline.yaml']);
  return {
    schemaVersion: project.schemaVersion,
    project: project.project,
    team: { members: team.members, roles: team.roles, limits: asRecord(project.team).limits ?? {} },
    pipeline: { columns: pipeline.columns, stages: pipeline.stages },
  };
}
