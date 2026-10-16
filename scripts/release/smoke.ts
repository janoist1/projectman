import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { CloudContext } from '../cloud/context';
import { CloudError, refused } from '../cloud/errors';
import { verifyImage } from '../cloud/images';
import type { BundleImage } from '../cloud/images';
import type { SmokeEvidence } from './receipt';

/**
 * The runtime proof of one image (PM-750). Export, load and inspect only prove integrity; this runs the image
 * itself, by its image ID, in a throwaway container with no mount, no published port and no network:
 * - Node loads better-sqlite3 natively and does real work in a temporary database;
 * - cloudflared, litestream and restic start and print their versions;
 * - the cloud server starts from a fixture home (a standby marker, no storage, mail or Access credential) and
 *   answers `/api/setup` from inside the container.
 * The production entrypoint, with its backup and tunnel branches, is replaced by a fixed one. The members' CLIs
 * are not part of the image and never run.
 */

const SERVER_PORT = 4700;
const FIXTURE_HOME = '/fixture';

/**
 * The fixed entrypoint of the smoke. Values the image decides (versions, architecture) are read inside and
 * printed as one `SMOKE_RESULT` JSON line; the host checks them against the manifest. It has no secret.
 */
export const SMOKE_SCRIPT = `set -euo pipefail
cd /app
native="$(node -e 'const Database = require("better-sqlite3"); const db = new Database("${FIXTURE_HOME}/probe.sqlite"); db.exec("create table probe (value text)"); db.prepare("insert into probe values (?)").run("ok"); console.log(JSON.stringify({ arch: process.arch, node: process.version, sqlite: db.prepare("select sqlite_version() as version").get().version, rows: db.prepare("select count(*) as count from probe").get().count })); db.close()')"
cloudflared_version="$(cloudflared --version 2>&1)"
litestream_version="$(litestream version 2>&1)"
restic_version="$(restic version 2>&1)"
printf '{"version":1,"role":"standby","reason":"release smoke","setAt":"%s"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >${FIXTURE_HOME}/instance.json
chmod 600 ${FIXTURE_HOME}/instance.json
env -i PATH="$PATH" HOME=/home/projectman TMPDIR=/tmp TZ=UTC LANG=C.UTF-8 NODE_ENV=production HOST=127.0.0.1 PORT=${SERVER_PORT} \\
  PROJECTMAN_MODE=cloud PROJECTMAN_HOME=${FIXTURE_HOME} PROJECTMAN_EMAIL_LOGIN_ENABLED=0 PROJECTMAN_PUBLIC_BOARD=0 \\
  node /app/apps/server/dist/index.js >/tmp/server.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
setup=''
for _ in $(seq 1 240); do
  if setup="$(curl -fsS --max-time 3 http://127.0.0.1:${SERVER_PORT}/api/setup 2>/dev/null)"; then break; fi
  setup=''
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "the server exited while starting" >&2
    tail -n 20 /tmp/server.log >&2
    exit 1
  fi
  sleep 1
done
if [ -z "$setup" ]; then
  echo "the server did not answer /api/setup" >&2
  tail -n 20 /tmp/server.log >&2
  exit 1
fi
SMOKE_NATIVE="$native" SMOKE_SETUP="$setup" SMOKE_CLOUDFLARED="$cloudflared_version" SMOKE_LITESTREAM="$litestream_version" SMOKE_RESTIC="$restic_version" \\
  node -e 'const e = process.env; console.log("SMOKE_RESULT " + JSON.stringify({ native: JSON.parse(e.SMOKE_NATIVE), helpers: { cloudflared: e.SMOKE_CLOUDFLARED, litestream: e.SMOKE_LITESTREAM, restic: e.SMOKE_RESTIC }, setup: JSON.parse(e.SMOKE_SETUP), revision: e.PROJECTMAN_VERSION }))'
`;

const version = z.string().regex(/\d+\.\d+\.\d+/);
const resultSchema = z.strictObject({
  native: z.strictObject({
    arch: z.enum(['arm64', 'x64']),
    node: z.string().regex(/^v\d+\.\d+\.\d+/),
    sqlite: z.string().min(1),
    rows: z.literal(1),
  }),
  helpers: z.strictObject({ cloudflared: version, litestream: version, restic: version }),
  setup: z.looseObject({ needsSetup: z.boolean() }),
  revision: z.string(),
});

const NODE_ARCH = { 'linux/arm64': 'arm64', 'linux/amd64': 'x64' } as const;

/** The whole `docker run` of one smoke: no mount, no port, no network, no host variable, no pull. */
export function smokeRunArgs(name: string, image: Pick<BundleImage, 'platform' | 'imageId'>): string[] {
  return [
    'run',
    '--rm',
    '--name',
    name,
    '--pull',
    'never',
    '--platform',
    image.platform,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,size=64m',
    '--tmpfs',
    `${FIXTURE_HOME}:rw,nosuid,uid=10001,gid=10001,mode=0700,size=128m`,
    '--tmpfs',
    '/home/projectman:rw,nosuid,uid=10001,gid=10001,mode=0700,size=64m',
    '--user',
    '10001:10001',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512',
    '--memory',
    '2g',
    '--entrypoint',
    '/bin/bash',
    image.imageId,
    '-c',
    SMOKE_SCRIPT,
  ];
}

export interface SmokeRequest {
  image: Pick<BundleImage, 'platform' | 'imageId'>;
  commit: string;
  signal: AbortSignal;
  timeoutMs: number;
}

/** The image Docker holds under this ID is the one the manifest names: platform, revision and version included. */
export async function assertImageLoaded(
  context: CloudContext,
  image: Pick<BundleImage, 'platform' | 'imageId'>,
  commit: string,
  signal: AbortSignal,
): Promise<void> {
  const label = `${image.platform} ${image.imageId}`;
  const inspected = await context.deps.run('docker', ['image', 'inspect', image.imageId], { signal });
  if (inspected.code !== 0) throw refused(`the image ${label} is not loaded in Docker`);
  try {
    verifyImage(JSON.parse(inspected.stdout), image.imageId, image.platform, commit);
  } catch {
    throw refused(`the loaded image ${label} does not match its ID, platform or revision`);
  }
}

export async function smokeImage(context: CloudContext, request: SmokeRequest): Promise<SmokeEvidence> {
  const { image, commit, signal } = request;
  const label = `${image.platform} ${image.imageId}`;
  await assertImageLoaded(context, image, commit, signal);
  const name = `pm-release-smoke-${randomBytes(6).toString('hex')}`;
  let result;
  try {
    result = await context.deps.run('docker', smokeRunArgs(name, image), {
      signal,
      timeoutMs: request.timeoutMs,
    });
  } finally {
    // Only our own throwaway container: it is removed whatever happened, an interrupt included. The removal
    // has a signal of its own: the interrupted one would stop it before it started.
    await context.deps
      .run('docker', ['rm', '--force', name], { timeoutMs: 60_000, signal: new AbortController().signal })
      .catch(() => undefined);
  }
  if (signal.aborted || result.code === 130) throw new CloudError(`the smoke of ${label} was interrupted`);
  if (result.code === 124) throw new CloudError(`the smoke of ${label} did not finish in time`);
  const line = result.stdout
    .split('\n')
    .filter((entry) => entry.startsWith('SMOKE_RESULT '))
    .at(-1);
  if (result.code !== 0 || !line) {
    const detail = result.stderr.trim().split('\n').slice(-6).join(' | ').slice(0, 600);
    throw new CloudError(
      `the smoke of ${label} failed (status ${result.code})${detail ? `: ${detail}` : ''}`,
    );
  }
  let proof: z.output<typeof resultSchema>;
  try {
    proof = resultSchema.parse(JSON.parse(line.slice('SMOKE_RESULT '.length)));
  } catch {
    throw new CloudError(`the smoke of ${label} answered with an invalid result`);
  }
  if (proof.native.arch !== NODE_ARCH[image.platform])
    throw new CloudError(
      `the smoke of ${label} ran on ${proof.native.arch}: the platform was not really run`,
    );
  if (proof.revision !== commit)
    throw new CloudError(`the smoke of ${label} reports revision ${proof.revision}, not ${commit}`);
  return {
    platform: image.platform,
    imageId: image.imageId,
    checkedAt: context.deps.now().toISOString(),
    nativeModules: true,
    helpers: true,
    cloudServer: true,
  };
}
