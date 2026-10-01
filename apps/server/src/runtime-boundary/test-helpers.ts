import type { BoundaryConfig } from './config';

/** A boundary configuration as deploy/vm/bootstrap.sh writes it (tests patch what they need). */
export function testBoundaryConfig(patch: Partial<BoundaryConfig> = {}): BoundaryConfig {
  return {
    schemaVersion: 1,
    profile: 'managed-vm',
    profileVersion: 2,
    serviceUser: 'projectman',
    launcher: { socket: '/run/projectman-launcher.sock', maxSessions: 2 },
    workers: {
      prefix: 'pmw-',
      homeRoot: '/var/lib/projectman-work',
      uidMin: 20000,
      uidMax: 20999,
      spoolRoot: '/var/lib/projectman-spool',
    },
    programs: {
      git: '/usr/bin/git',
      mkdir: '/usr/bin/mkdir',
      rm: '/usr/bin/rm',
      mv: '/usr/bin/mv',
      claude: '/opt/projectman/cli/bin/claude',
      codex: '/opt/projectman/cli/bin/codex',
      node: '/usr/local/bin/node',
    },
    appDir: '/srv/projectman',
    bridgeRoot: '/run/projectman-bridge',
    systemdRun: '/usr/bin/systemd-run',
    systemctl: '/usr/bin/systemctl',
    workerPath: '/opt/projectman/cli/bin:/usr/local/bin:/usr/bin:/bin',
    egress: {
      host: '127.0.0.1',
      port: 4780,
      grantHours: 8,
      base: [{ host: 'registry.npmjs.org', port: 443 }],
    },
    readiness: { report: '/var/lib/projectman-boundary/readiness.json', maxAgeSeconds: 7200 },
    appPort: 4700,
    ...patch,
  };
}
