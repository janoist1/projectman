import { parseDocument, stringify, visit } from 'yaml';
import type { ProjectConfig } from '@projectman/shared';
import { ConfigStoreError } from './errors';

/**
 * File layout of one project in the customization repository:
 *   projects/<KEY>/project.yaml   schemaVersion, project, team.limits
 *   projects/<KEY>/team.yaml      members, custom roles
 *   projects/<KEY>/pipeline.yaml  columns, stages, labels
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
    'team.yaml': yaml({
      members: config.team.members,
      roles: config.team.roles,
      roleOverrides: config.team.roleOverrides,
      releaseFourEyes: config.team.releaseFourEyes,
    }),
    'pipeline.yaml': yaml({
      columns: config.pipeline.columns,
      stages: config.pipeline.stages,
      labels: config.pipeline.labels,
    }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseYamlFile(file: string, text: string): unknown {
  try {
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('YAML exceeds 1 MiB');
    const doc = parseDocument(text, { prettyErrors: false });
    if (doc.errors.length) throw new Error('invalid YAML');
    visit(doc, (_key, _node, path) => {
      if (path.length > 50) throw new Error('YAML nesting exceeds 50 levels');
    });
    return doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw new ConfigStoreError('invalid_yaml', `invalid or excessive YAML in ${file}`, { file });
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
    team: {
      members: team.members,
      roles: team.roles,
      roleOverrides: team.roleOverrides,
      releaseFourEyes: team.releaseFourEyes,
      limits: asRecord(project.team).limits ?? {},
    },
    pipeline: { columns: pipeline.columns, stages: pipeline.stages, labels: pipeline.labels },
  };
}
