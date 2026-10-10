import type { CardMover, ProjectConfig } from '@projectman/shared';

export interface TemplateOwner {
  handle: string;
  displayName: string;
  email: string;
}

export interface BuildTemplateInput {
  cardMover?: CardMover;
  key: string;
  name: string;
  workspacePath: string;
  /** Project language; picks the locale for default display names. */
  language: string;
  owner: TemplateOwner;
}

export interface ProjectTemplate {
  id: string;
  /** i18n keys translated by the web app: "templates.<id>.name" / "templates.<id>.description". */
  nameKey: string;
  descriptionKey: string;
  /** Returns a configuration that passes ProjectConfig.parse and validateProjectConfig. */
  build(input: BuildTemplateInput): ProjectConfig;
}
