import type { AgentProvider, CardMover, ChecklistCondition, Merger, ProjectConfig } from '@projectman/shared';
import type { ChecklistItemKey } from './locales/types';

export interface TemplateOwner {
  handle: string;
  displayName: string;
  email: string;
}

export interface BuildTemplateInput {
  provider?: AgentProvider;
  cardMover?: CardMover;
  /** Who merges approved work into the default branch; absent: the one the pipeline implies (`defaultMerger`). */
  merger?: Merger;
  key: string;
  name: string;
  workspacePath: string;
  /** Project language; picks the locale for default display names. */
  language: string;
  owner: TemplateOwner;
}

/** A checklist item a template adds to the project's startup checklist; title and hint come from the locale. */
export interface TemplateChecklistItem {
  id: ChecklistItemKey;
  condition: ChecklistCondition | null;
}

export interface ProjectTemplate {
  id: string;
  /** i18n keys translated by the web app: "templates.<id>.name" / "templates.<id>.description". */
  nameKey: string;
  descriptionKey: string;
  /** The items the template adds to the startup checklist, next to the base list (PM-977). */
  checklist: readonly TemplateChecklistItem[];
  /** Returns a configuration that passes ProjectConfig.parse and validateProjectConfig. */
  build(input: BuildTemplateInput): ProjectConfig;
}
