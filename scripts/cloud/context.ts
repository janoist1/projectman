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

/**
 * Where the EC2 machine is and how AWS is reached (PM-1197): a named profile of this computer (from
 * `config.json`), or the ambient credentials of a GitHub runner (`runner-deploy`, from its flags). A configuration
 * file cannot say `ambient`; only `runner-deploy` builds that shape.
 */
export type HostAws = { region: string; instanceName: string } & (
  { profile: string; ambient?: undefined } | { ambient: true; profile?: undefined }
);

/** What a deploy onto the machine needs: the processes and the output, and no configuration file. */
export type DeployContext = Pick<CloudContext, 'deps' | 'report'>;

/** What a session on the machine needs: a deploy context and the machine's place. */
export type HostContext = DeployContext & { config: { aws: HostAws } };
