import type { CloudConfig } from './config';
import type { CloudDeps } from './deps';
import type { Report } from './report';

/** What every cloud command gets: the outside world, the checked configuration, the report and the secrets store. */
export interface CloudContext {
  deps: CloudDeps;
  config: CloudConfig;
  report: Report;
  /** `~/.config/projectman/cloud`. */
  secretsDir: string;
  /** `<secretsDir>/cloud.env`. */
  envFile: string;
}
