import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bootstrapFile = new URL('../../../deploy/aws/ec2-bootstrap.sh', import.meta.url);

describe('the public EC2 bootstrap', () => {
  it('parses as bash and contains only the public SSH/EIC/SSM bootstrap', () => {
    const result = spawnSync('bash', ['-n', bootstrapFile.pathname], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const script = readFileSync(bootstrapFile, 'utf8');
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('systemctl enable --now ssh');
    expect(script).toContain('snap start --enable amazon-ssm-agent');
    expect(script).not.toMatch(
      /(?:ACCESS_KEY|TOKEN|PASSWORD|cloud\.env|engine\.key|send-command|docker run)/,
    );
    expect(Buffer.byteLength(script)).toBeLessThan(16 * 1024);
  });
});
