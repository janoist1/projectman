import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import type { CloudDeps, RunResult } from '../../../scripts/cloud/deps';
import { DEPLOY_ENVIRONMENT, DEPLOY_ROLE_NAME } from '../../../scripts/cloud/github-deploy-setup';
import { ACCOUNT } from './helpers/fake-aws';
import { EC2_HOST_ID, Ec2HostWorld } from './helpers/fake-ec2-host';

/** `npm run cloud -- github-deploy-setup`: the OIDC provider, the role and the GitHub environment (PM-1197). */

const REPOSITORY = 'janoist1/projectman';
const ENVIRONMENT_ROUTE = `repos/${REPOSITORY}/environments/${DEPLOY_ENVIRONMENT}`;
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/${DEPLOY_ROLE_NAME}`;
const PROVIDER_ARN = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;

/** The GitHub side the fake `gh api` keeps: the environment, its branch policies and its variables. */
class FakeGithub {
  environment: unknown = null;
  policies: { id: number; name: string }[] = [];
  variables = new Map<string, string>();
  readonly calls: { method: string; route: string; body: unknown }[] = [];
  private nextId = 1;

  mutations(): string[] {
    return this.calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.route}`);
  }

  run(args: string[], input: string | undefined): RunResult {
    const method = args[args.indexOf('--method') + 1]!;
    const route = args[args.indexOf('--method') + 2]!;
    const body = input === undefined ? undefined : (JSON.parse(input) as Record<string, string>);
    this.calls.push({ method, route, body });
    const ok = (value: unknown = {}): RunResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
    const notFound: RunResult = { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
    if (route === `repos/${REPOSITORY}`) return ok({ default_branch: 'main' });
    if (route === ENVIRONMENT_ROUTE) {
      if (method === 'PUT') {
        this.environment = body;
        return ok();
      }
      return this.environment ? ok(this.environment) : notFound;
    }
    const policies = `${ENVIRONMENT_ROUTE}/deployment-branch-policies`;
    if (route === policies) {
      if (method === 'POST') {
        this.policies.push({ id: this.nextId++, name: body!.name! });
        return ok();
      }
      return ok({ branch_policies: this.policies });
    }
    if (route.startsWith(`${policies}/`) && method === 'DELETE') {
      this.policies = this.policies.filter((policy) => `${policies}/${policy.id}` !== route);
      return ok();
    }
    const variables = `${ENVIRONMENT_ROUTE}/variables`;
    if (route === variables && method === 'POST') {
      this.variables.set(body!.name!, body!.value!);
      return ok();
    }
    if (route.startsWith(`${variables}/`)) {
      const name = route.slice(variables.length + 1);
      if (method === 'PATCH') {
        this.variables.set(name, body!.value!);
        return ok();
      }
      return this.variables.has(name) ? ok({ name, value: this.variables.get(name) }) : notFound;
    }
    return { code: 1, stdout: '', stderr: `fake gh: unexpected ${method} ${route}` };
  }
}

let world: Ec2HostWorld;
let github: FakeGithub;

beforeEach(() => {
  world = Ec2HostWorld.configured();
  github = new FakeGithub();
});
afterEach(() => world.cleanup());

function deps(): CloudDeps {
  const base = world.deps();
  return {
    ...base,
    run: async (command, args, options) =>
      command === 'gh' ? github.run(args, options?.input) : base.run(command, args, options),
  };
}

const run = (...argv: string[]) => runCloud(['github-deploy-setup', ...argv], deps());
const role = () => world.aws.roles.get(DEPLOY_ROLE_NAME)!;
const policy = () =>
  role().policies.get(DEPLOY_ROLE_NAME) as {
    Statement: { Action: string | string[]; Resource: string | string[] }[];
  };

describe('github-deploy-setup', () => {
  it('creates the provider, the role with its policy, the environment limited to the default branch and the variables', async () => {
    expect(await run()).toBe(0);
    expect(world.aws.oidcProviders.get(PROVIDER_ARN)?.ClientIDList).toEqual(['sts.amazonaws.com']);
    expect(role().maxSessionDuration).toBe(3600);
    expect(role().policies.size).toBe(1);
    expect(github.environment).toEqual({
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
    expect(github.policies.map((item) => item.name)).toEqual(['main']);
    expect(Object.fromEntries(github.variables)).toEqual({
      PROJECTMAN_DEPLOY_ROLE_ARN: ROLE_ARN,
      PROJECTMAN_AWS_REGION: 'eu-west-1',
      PROJECTMAN_INSTANCE_NAME: 'projectman-cloud',
    });
  });

  it('is idempotent: a second run changes nothing', async () => {
    expect(await run()).toBe(0);
    world.aws.clearCalls();
    github.calls.length = 0;
    expect(await run()).toBe(0);
    expect(world.aws.mutations()).toEqual([]);
    expect(github.mutations()).toEqual([]);
  });

  it('lets only the cloud-production environment of this repository assume the role, with the audience checked', async () => {
    expect(await run()).toBe(0);
    expect(role().trust).toMatchObject({
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sts:AssumeRoleWithWebIdentity',
          Principal: { Federated: PROVIDER_ARN },
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub': `repo:${REPOSITORY}:environment:${DEPLOY_ENVIRONMENT}`,
            },
          },
        },
      ],
    });
  });

  it('gives the role only SSM and connection rights, on the one machine', async () => {
    expect(await run()).toBe(0);
    const actions = policy().Statement.flatMap((statement) => [statement.Action].flat());
    expect(actions.every((action) => /^(ssm|ec2|ec2-instance-connect):/.test(action))).toBe(true);
    // Only the lookups that AWS cannot scope to a resource may name every resource, and they only read.
    for (const statement of policy().Statement)
      if ([statement.Resource].flat().includes('*'))
        expect(
          [statement.Action].flat().every((action) => /^(ec2:Describe|ssm:(Describe|Get))/.test(action)),
        ).toBe(true);
    const instance = `arn:aws:ec2:eu-west-1:${ACCOUNT}:instance/${EC2_HOST_ID}`;
    expect(JSON.stringify(policy())).toContain(instance);
    expect(JSON.stringify(policy())).not.toMatch(/"iam:|"s3:|"sts:/);
  });

  it('puts a drifted trust policy, a stale branch policy and a wrong variable right', async () => {
    expect(await run()).toBe(0);
    role().trust = { Version: '2012-10-17', Statement: [] };
    github.policies.push({ id: 99, name: 'feature' });
    github.variables.set('PROJECTMAN_AWS_REGION', 'us-east-1');
    world.aws.clearCalls();
    github.calls.length = 0;
    expect(await run()).toBe(0);
    expect(world.aws.mutations()).toEqual(['iam update-assume-role-policy']);
    expect(github.policies.map((item) => item.name)).toEqual(['main']);
    expect(github.variables.get('PROJECTMAN_AWS_REGION')).toBe('eu-west-1');
  });

  it('refuses a role that allows sessions longer than the deploy needs', async () => {
    expect(await run()).toBe(0);
    role().maxSessionDuration = 43_200;
    expect(await run()).toBe(2);
    expect(world.output).toContain('shorten it by hand');
  });

  it('--dry-run reads only: nothing is created in AWS or on GitHub', async () => {
    expect(await run('--dry-run')).toBe(0);
    expect(world.aws.mutations()).toEqual([]);
    expect(world.aws.roles.size).toBe(0);
    expect(world.aws.oidcProviders.size).toBe(0);
    expect(github.mutations()).toEqual([]);
    expect(world.output).toContain('dry-run');
  });
});
