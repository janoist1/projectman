import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HybridReleaseTarget, ProjectConfig, RepoConfig } from '@projectman/shared';
import { refused } from './errors';
import { CLOUDFLARE_TOKEN_FILE_NAME, CONFIG_FILE_NAME, secretsDir } from './secrets';

/**
 * The configuration file of the cloud commands (PM-534): `~/.config/projectman/cloud/config.json`, or the file
 * `--config` names. No secret is in it. The Cloudflare and DNS fields are only validated here; the later parts of
 * the cloud board use them (PM-535 to PM-537).
 */

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
/** S3 rules for a bucket that is used with path-style and virtual-host-style access: no dots. */
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const RESERVED_BUCKET_PARTS = [/^xn--/, /^sthree-/, /-s3alias$/, /--ol-s3$/, /--x-s3$/];
/** Instance and IAM names: the IAM user is `<name>-litestream`, at most 64 characters. */
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ZONE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/;

const bucketName = z
  .string()
  .regex(BUCKET, 'an S3 bucket name: 3-63 lowercase letters, digits and hyphens, no dots')
  .refine((name) => !RESERVED_BUCKET_PARTS.some((part) => part.test(name)), 'a reserved S3 bucket name part')
  .refine((name) => !/^\d+-\d+-\d+-\d+$/.test(name), 'a bucket name must not look like an IP address');

const awsSchema = z
  .strictObject({
    compute: z
      .literal('ec2', {
        error: (issue) =>
          issue.input === 'lightsail'
            ? 'Lightsail is no longer supported; set aws.compute to "ec2" (docs/AWS.md)'
            : 'must be "ec2"',
      })
      .default('ec2'),
    profile: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, 'a non-empty profile')
      .optional(),
    region: z.string().regex(REGION, 'an AWS region such as eu-west-1'),
    availabilityZone: z
      .string()
      .regex(/^[a-z]{2}(?:-[a-z]+)+-\d{1,2}[a-z]$/, 'an availability zone such as eu-west-1a')
      .optional(),
    instanceName: z
      .string()
      .regex(INSTANCE_NAME, 'letters, digits, hyphens and underscores, at most 50 characters')
      .default('projectman-cloud'),
    databaseBucket: bucketName,
    backupBucket: bucketName,
    ec2: z
      .strictObject({
        architecture: z.enum(['x86_64', 'arm64']).default('x86_64'),
        instanceType: z
          .string()
          .max(64)
          .regex(/^[a-z][a-z0-9-]*\.[a-z0-9]+$/, 'an EC2 instance type such as t3.small'),
        amiId: z.string().regex(/^ami-[0-9a-f]{8,17}$/, 'an AMI id'),
        vpcId: z.string().regex(/^vpc-(?:[0-9a-f]{8}|[0-9a-f]{17})$/, 'a VPC id'),
        subnetId: z.string().regex(/^subnet-(?:[0-9a-f]{8}|[0-9a-f]{17})$/, 'a subnet id'),
        volumeGiB: z.number().int().min(20).max(1024),
      })
      .optional(),
  })
  .superRefine((aws, context) => {
    if (aws.profile === undefined || aws.profile === 'i')
      context.addIssue({
        code: 'custom',
        path: ['profile'],
        message: 'EC2 requires an explicit central-account profile; the registrar profile i is refused',
      });
  })
  .transform((aws) => ({ ...aws, profile: aws.profile ?? 'i' }));

const repositorySchema = z.strictObject({
  url: z
    .string()
    .refine((value) => URL.canParse(value) && new URL(value).protocol === 'https:', 'an https:// URL')
    .default('https://github.com/janoist1/projectman.git'),
});

const cloudflareSchema = z.strictObject({
  accountId: z
    .string()
    .regex(/^[0-9a-f]{32}$/i, '32 hexadecimal characters')
    .optional(),
  tokenFile: z.string().min(1).optional(),
  zone: z.string().regex(ZONE, 'a lowercase domain name such as example.com'),
  hostname: z.string().min(1),
  feedbackHostname: z.string().min(1).optional(),
  integratorHostname: z.string().min(1).optional(),
  tunnelName: z.string().min(1).optional(),
});

const accessEmail = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => !value.includes('*'), 'an exact address, no wildcard')
  .refine((value) => EMAIL.test(value), 'an e-mail address');

/** A further owner's own Cloudflare service tokens (PM-1065); the id has the shape of a member handle. */
const accessOwnerSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'lowercase letters, digits and hyphens, at most 32'),
  /** Appears only in the output lines. */
  name: z.string().trim().min(1).max(80),
  email: accessEmail.optional(),
});

const accessSchema = z.strictObject({
  emails: z.array(accessEmail).min(1, 'at least one address'),
  /**
   * The further owners (PM-1065): each gets an engine and an integrator service token and its own policies on
   * the `/engine` application and the integrator hostname; `edge` removes the ones that left the list.
   */
  owners: z.array(accessOwnerSchema).default([]),
  sessionDuration: z
    .string()
    .regex(/^[1-9]\d*[mh]$/, 'a duration such as 30m or 24h')
    .default('24h'),
  integratorServiceToken: z.boolean().default(false),
  /**
   * `private`: Cloudflare Access (the listed e-mail addresses) is in front of the whole board.
   * `public` (PM-672): the board's own login (the owner's password, the clients' e-mail code) is the
   * browser boundary; the engine path and configured integrator hostname retain their own guards.
   */
  boardMode: z.enum(['private', 'public']).default('private'),
});

const route53Schema = z.strictObject({
  profile: z.string().min(1).optional(),
  hostedZoneId: z
    .string()
    .regex(/^Z[A-Z0-9]{4,31}$/, 'a hosted zone id such as Z0123456789ABC')
    .optional(),
});

const sesSchema = z.strictObject({
  /** The AWS account that owns the SES identity and the sender IAM user; defaults to `aws.profile` (PM-729). */
  profile: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, 'a non-empty profile')
    .optional(),
  region: z.string().regex(REGION, 'an explicit AWS SES region'),
  domain: z.string().max(253).regex(ZONE, 'a lowercase domain name'),
  from: z.email().max(254),
  /** Receiving the replies of the e-mail channel with SES (PM-945); absent: the receiving commands are refused. */
  inbound: z
    .strictObject({
      /** A subdomain of the Cloudflare zone that carries only the replies' MX record. */
      replyDomain: z.string().max(253).regex(ZONE, 'a lowercase domain name'),
    })
    .optional(),
});

/**
 * The project and repository that are the board itself (PM-749): the release target the cloud server
 * (`PROJECTMAN_RELEASE_TARGET=<projectKey>/<repo>`) accepts releases for. The same identifier schemas as the
 * project configuration; a value that does not match them never reaches cloud.env.
 */
const releaseTargetSchema = z.strictObject({
  projectKey: ProjectConfig.shape.project.shape.key,
  repo: RepoConfig.shape.name,
});

const configSchema = z
  .strictObject({
    version: z.literal(1),
    releaseTarget: releaseTargetSchema.optional(),
    /** The remote engine and the target hash a hybrid release goes to (PM-752); needs `releaseTarget`. */
    hybrid: HybridReleaseTarget.optional(),
    aws: awsSchema,
    repository: repositorySchema.prefault({}),
    cloudflare: cloudflareSchema,
    access: accessSchema,
    route53: route53Schema.prefault({}),
    ses: sesSchema.optional(),
    deployment: z.strictObject({ imageBundle: z.string().trim().min(1) }).optional(),
  })
  .superRefine((config, context) => {
    const issue = (pathParts: (string | number)[], message: string) =>
      context.addIssue({ code: 'custom', path: pathParts, message });
    const { aws, cloudflare, access } = config;
    if (config.hybrid && !config.releaseTarget) issue(['hybrid'], 'needs releaseTarget');
    if (aws.ec2?.architecture === 'arm64' && !config.deployment)
      issue(['deployment', 'imageBundle'], 'required for arm64');
    if (config.ses) {
      if (config.ses.from.split('@')[1] !== config.ses.domain)
        issue(['ses', 'from'], 'must be an address of exactly ses.domain');
      if (config.ses.domain !== cloudflare.zone && !config.ses.domain.endsWith(`.${cloudflare.zone}`))
        issue(['ses', 'domain'], 'must belong to the configured Cloudflare zone');
      const replyDomain = config.ses.inbound?.replyDomain;
      if (replyDomain !== undefined) {
        const path = ['ses', 'inbound', 'replyDomain'];
        if (!replyDomain.endsWith(`.${cloudflare.zone}`))
          issue(path, 'must be a subdomain of the configured Cloudflare zone');
        else if (replyDomain === config.ses.domain) issue(path, 'must differ from ses.domain');
      }
    }
    if (!aws.ec2)
      issue(['aws', 'ec2'], 'required for EC2; explicitly choose the type, AMI, VPC, subnet and disk size');
    if (aws.databaseBucket === aws.backupBucket)
      issue(['aws', 'backupBucket'], 'must differ from databaseBucket');
    if (aws.availabilityZone && !aws.availabilityZone.startsWith(aws.region))
      issue(['aws', 'availabilityZone'], `must be in the region ${aws.region}`);
    const firstLevel = (field: 'hostname' | 'feedbackHostname' | 'integratorHostname', value: string) => {
      const label = value.endsWith(`.${cloudflare.zone}`) ? value.slice(0, -cloudflare.zone.length - 1) : '';
      if (!DNS_LABEL.test(label)) issue(['cloudflare', field], `must be <label>.${cloudflare.zone}`);
    };
    firstLevel('hostname', cloudflare.hostname);
    if (cloudflare.feedbackHostname !== undefined) {
      firstLevel('feedbackHostname', cloudflare.feedbackHostname);
      if (cloudflare.feedbackHostname === cloudflare.hostname)
        issue(['cloudflare', 'feedbackHostname'], 'must differ from hostname');
    }
    if (cloudflare.integratorHostname !== undefined) {
      firstLevel('integratorHostname', cloudflare.integratorHostname);
      if ([cloudflare.hostname, cloudflare.feedbackHostname].includes(cloudflare.integratorHostname))
        issue(['cloudflare', 'integratorHostname'], 'must differ from the board and feedback hostnames');
      if (!access.integratorServiceToken)
        issue(['access', 'integratorServiceToken'], 'required with integratorHostname');
    }
    if (access.boardMode === 'public' && access.integratorServiceToken && !cloudflare.integratorHostname)
      issue(['cloudflare', 'integratorHostname'], 'required for public integrator access');
    if (access.boardMode === 'public' && !config.ses)
      issue(['access', 'boardMode'], 'public needs the ses block: clients log in with an e-mailed code');
    const seen = new Set<string>();
    access.emails.forEach((email, index) => {
      if (seen.has(email)) issue(['access', 'emails', index], `${email} is listed twice`);
      seen.add(email);
    });
    if (access.owners.length > 0 && !cloudflare.integratorHostname)
      issue(['cloudflare', 'integratorHostname'], 'required with access.owners');
    const seenOwners = new Set<string>();
    access.owners.forEach((owner, index) => {
      if (seenOwners.has(owner.id)) issue(['access', 'owners', index, 'id'], `${owner.id} is listed twice`);
      seenOwners.add(owner.id);
      if (access.boardMode === 'private' && owner.email === undefined)
        issue(['access', 'owners', index, 'email'], 'required in private board mode');
    });
  });

export type ParsedCloudConfig = z.output<typeof configSchema>;

/** The configuration with every default filled in. */
export interface CloudConfig {
  deployment?: { imageBundle: string };
  /** Absent: the board does not release (PM-749). */
  releaseTarget?: { projectKey: string; repo: string };
  /** Absent: the board releases to the cloud server only (PM-752). */
  hybrid?: { engineId: string; targetHash: string };
  version: 1;
  aws: {
    compute: 'ec2';
    profile: string;
    region: string;
    availabilityZone: string;
    instanceName: string;
    databaseBucket: string;
    backupBucket: string;
    ec2?: NonNullable<ParsedCloudConfig['aws']['ec2']>;
  };
  repository: { url: string };
  cloudflare: {
    accountId?: string;
    tokenFile: string;
    zone: string;
    hostname: string;
    feedbackHostname?: string;
    integratorHostname?: string;
    tunnelName: string;
  };
  access: {
    emails: string[];
    owners: { id: string; name: string; email?: string }[];
    sessionDuration: string;
    integratorServiceToken: boolean;
    boardMode: 'private' | 'public';
  };
  route53: { profile: string; hostedZoneId?: string };
  /** `profile` is `ses.profile`, or `aws.profile` when the block names none (PM-729). */
  ses?: NonNullable<ParsedCloudConfig['ses']> & { profile: string };
}

export function defaultConfigPath(homeDir: string): string {
  return path.join(secretsDir(homeDir), CONFIG_FILE_NAME);
}

/** `~/…` is the user's home directory; anything else must already be absolute. */
export function expandHome(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  return value.startsWith('~/') ? path.join(homeDir, value.slice(2)) : value;
}

function fieldPath(issuePath: readonly PropertyKey[]): string {
  return issuePath.length === 0 ? '(file)' : issuePath.map(String).join('.');
}

/** Validates an already parsed JSON value; a bad field is refused with its path (exit status 2). */
export function parseConfig(raw: unknown, homeDir: string, configDir = process.cwd()): CloudConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${fieldPath(issue.path)}: ${issue.message}`);
    throw refused(`the configuration is not valid:\n${lines.join('\n')}`);
  }
  const parsed = result.data;
  const tokenFile = expandHome(
    parsed.cloudflare.tokenFile ?? path.join(secretsDir(homeDir), CLOUDFLARE_TOKEN_FILE_NAME),
    homeDir,
  );
  if (!path.isAbsolute(tokenFile))
    throw refused('the configuration is not valid:\n  cloudflare.tokenFile: must be an absolute path or ~/…');
  return {
    version: 1,
    aws: {
      ...parsed.aws,
      availabilityZone: parsed.aws.availabilityZone ?? `${parsed.aws.region}a`,
    },
    repository: parsed.repository,
    cloudflare: {
      ...parsed.cloudflare,
      tokenFile,
      tunnelName: parsed.cloudflare.tunnelName ?? parsed.aws.instanceName,
    },
    access: parsed.access,
    route53: { ...parsed.route53, profile: parsed.route53.profile ?? parsed.aws.profile },
    ...(parsed.ses ? { ses: { ...parsed.ses, profile: parsed.ses.profile ?? parsed.aws.profile } } : {}),
    ...(parsed.releaseTarget ? { releaseTarget: parsed.releaseTarget } : {}),
    ...(parsed.hybrid ? { hybrid: parsed.hybrid } : {}),
    ...(parsed.deployment
      ? {
          deployment: {
            imageBundle: path.resolve(configDir, expandHome(parsed.deployment.imageBundle, homeDir)),
          },
        }
      : {}),
  };
}

/** Reads and validates the configuration file (exit status 2 when it is missing or wrong). */
export function loadConfig(file: string, homeDir: string): CloudConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw refused(
        `no configuration file at ${file}; copy deploy/aws/config.example.json there and fill it in`,
      );
    throw refused(`cannot read the configuration file ${file}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw refused(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  return parseConfig(raw, homeDir, path.dirname(path.resolve(file)));
}
