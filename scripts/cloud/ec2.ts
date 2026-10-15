import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AwsCallError } from './aws-cli';
import type { AwsCli } from './aws-cli';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';

/** EC2 provisioning runs on the owner's machine, with the central account's explicit CLI target (PM-676). */
const CANONICAL_OWNER = '099720109477';
const SSM_POLICY = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore';
function imageName(architecture: 'x86_64' | 'arm64') {
  return new RegExp(
    `^ubuntu/images/hvm-ssd(?:-gp3)?/ubuntu-noble-24\\.04-${architecture === 'arm64' ? 'arm64' : 'amd64'}-server-\\d{8}(?:\\.\\d+)?$`,
  );
}
const TAGS = z.array(z.looseObject({ Key: z.string(), Value: z.string() }));
const trust = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
};
const imageSchema = z.looseObject({
  ImageId: z.string(),
  OwnerId: z.string(),
  Name: z.string(),
  State: z.string(),
  Architecture: z.string(),
  VirtualizationType: z.string(),
  RootDeviceType: z.string(),
  RootDeviceName: z.string(),
  BlockDeviceMappings: z.array(
    z.looseObject({
      DeviceName: z.string(),
      Ebs: z.looseObject({ VolumeSize: z.number().int() }).optional(),
      VirtualName: z.string().optional(),
    }),
  ),
  ProductCodes: z.array(z.unknown()).optional(),
});
const subnetSchema = z.looseObject({
  SubnetId: z.string(),
  VpcId: z.string(),
  OwnerId: z.string(),
  AvailabilityZone: z.string(),
  State: z.string(),
  AvailableIpAddressCount: z.number().int(),
});
const permissionSchema = z.looseObject({
  IpProtocol: z.string(),
  IpRanges: z.array(z.looseObject({ CidrIp: z.string() })).optional(),
});
const groupSchema = z.looseObject({
  GroupId: z.string(),
  GroupName: z.string(),
  VpcId: z.string(),
  OwnerId: z.string(),
  Tags: TAGS.optional(),
  IpPermissions: z.array(z.unknown()),
  IpPermissionsEgress: z.array(permissionSchema),
});
const roleSchema = z.looseObject({
  RoleName: z.string(),
  Arn: z.string(),
  Tags: TAGS.optional(),
  AssumeRolePolicyDocument: z.unknown(),
});
const profileSchema = z.looseObject({
  InstanceProfileName: z.string(),
  Arn: z.string(),
  Tags: TAGS.optional(),
  Roles: z.array(roleSchema),
});
const instanceSchema = z.looseObject({
  InstanceId: z.string(),
  ImageId: z.string(),
  InstanceType: z.string(),
  VpcId: z.string(),
  SubnetId: z.string(),
  State: z.looseObject({ Name: z.string() }),
  Tags: TAGS.optional(),
  Architecture: z.string(),
  RootDeviceName: z.string(),
  RootDeviceType: z.string(),
  VirtualizationType: z.string(),
  MetadataOptions: z.looseObject({
    HttpTokens: z.string(),
    HttpPutResponseHopLimit: z.number(),
    HttpEndpoint: z.string(),
  }),
  SecurityGroups: z.array(z.looseObject({ GroupId: z.string() })),
  IamInstanceProfile: z.looseObject({ Arn: z.string() }).optional(),
  BlockDeviceMappings: z.array(
    z.looseObject({
      DeviceName: z.string(),
      Ebs: z.looseObject({ VolumeId: z.string(), DeleteOnTermination: z.boolean() }),
    }),
  ),
  NetworkInterfaces: z.array(
    z.looseObject({
      NetworkInterfaceId: z.string(),
      Groups: z.array(z.looseObject({ GroupId: z.string() })),
    }),
  ),
  PublicIpAddress: z.string().optional(),
  InstanceLifecycle: z.string().optional(),
});
type Instance = z.output<typeof instanceSchema>;
type Resources = {
  group: z.output<typeof groupSchema> | null;
  role: z.output<typeof roleSchema> | null;
  profile: z.output<typeof profileSchema> | null;
  instance: Instance | null;
};

function desired(context: CloudContext) {
  const value = context.config.aws.ec2;
  if (!value || context.config.aws.compute !== 'ec2') throw refused('the EC2 configuration is missing');
  return value;
}
function tags(name: string) {
  return [
    { Key: 'Name', Value: name },
    { Key: 'ProjectmanManaged', Value: 'true' },
  ];
}
function managed(actual: z.output<typeof TAGS> | undefined, name: string): boolean {
  return tags(name).every(
    (wanted) =>
      actual?.filter((tag) => tag.Key === wanted.Key).length === 1 &&
      actual.some((tag) => tag.Key === wanted.Key && tag.Value === wanted.Value),
  );
}
function hostName(context: CloudContext) {
  return `${context.config.aws.instanceName}-host`;
}
function profileArn(context: CloudContext, account: string) {
  return `arn:aws:iam::${account}:instance-profile/${hostName(context)}`;
}
function costPreview(context: CloudContext) {
  const ec2 = desired(context);
  context.report.line(
    `cost instance: ${ec2.instanceType}, Linux On-Demand in ${context.config.aws.region}; running hours (730 hours/month if always on)`,
  );
  context.report.line(
    `cost EBS: encrypted gp3 ${ec2.volumeGiB} GiB, baseline 3000 IOPS/125 MiB/s; charged while stopped too`,
  );
  context.report.line(
    'cost IPv4: one auto-assigned public IPv4, billed while allocated; no Elastic IP, NAT, load balancer or second machine',
  );
  context.report.line(
    'cost other: internet data transfer, S3 storage/requests; burstable CPU credits are standard, with no unlimited-credit surcharge',
  );
  context.report.line(
    'Review current regional rates before approval: https://aws.amazon.com/ec2/pricing/on-demand/ https://aws.amazon.com/ebs/pricing/ https://aws.amazon.com/vpc/pricing/',
  );
}

/** Read-only catalogue and network checks. Never picks an image, type, region or paid disk size for the owner. */
async function environment(context: CloudContext, cli: AwsCli, account: string, catalogue: boolean) {
  const ec2 = desired(context);
  const regions = await cli.callAs(
    ['ec2', 'describe-regions', '--region-names', context.config.aws.region],
    z.looseObject({ Regions: z.array(z.looseObject({ RegionName: z.string(), OptInStatus: z.string() })) }),
  );
  if (
    !regions.Regions.some(
      (region) =>
        region.RegionName === context.config.aws.region &&
        ['opt-in-not-required', 'opted-in'].includes(region.OptInStatus),
    )
  )
    throw refused('the configured EC2 region is not enabled');
  if (catalogue) {
    const images = await cli.callAs(
      [
        'ec2',
        'describe-images',
        '--owners',
        CANONICAL_OWNER,
        '--filters',
        `Name=name,Values=ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-${ec2.architecture === 'arm64' ? 'arm64' : 'amd64'}-server-*`,
        'Name=state,Values=available',
        `Name=architecture,Values=${ec2.architecture}`,
        'Name=virtualization-type,Values=hvm',
        'Name=root-device-type,Values=ebs',
      ],
      z.looseObject({ Images: z.array(imageSchema) }),
    );
    for (const image of images.Images.filter((image) => imageName(ec2.architecture).test(image.Name)))
      context.report.line(
        `available Ubuntu 24.04 ${ec2.architecture === 'arm64' ? 'arm64' : 'amd64'}: ${image.ImageId} ${image.Name}`,
      );
  }
  const answer = await cli.callAs(
    ['ec2', 'describe-images', '--image-ids', ec2.amiId],
    z.looseObject({ Images: z.array(imageSchema) }),
  );
  const image = answer.Images[0];
  const ebsMappings = image?.BlockDeviceMappings.filter((mapping) => mapping.Ebs) ?? [];
  const ephemeralMappings = image?.BlockDeviceMappings.filter((mapping) => !mapping.Ebs) ?? [];
  if (
    answer.Images.length !== 1 ||
    !image ||
    image.ImageId !== ec2.amiId ||
    image.OwnerId !== CANONICAL_OWNER ||
    !imageName(ec2.architecture).test(image.Name) ||
    image.State !== 'available' ||
    image.Architecture !== ec2.architecture ||
    image.VirtualizationType !== 'hvm' ||
    image.RootDeviceType !== 'ebs' ||
    image.ProductCodes?.length ||
    ebsMappings.length !== 1 ||
    ebsMappings[0]?.DeviceName !== image.RootDeviceName ||
    !ebsMappings[0].Ebs ||
    ebsMappings[0].VirtualName !== undefined ||
    ebsMappings[0].Ebs.VolumeSize > ec2.volumeGiB ||
    ephemeralMappings.some(
      (mapping) => !/^ephemeral(?:[0-9]|1[0-9]|2[0-3])$/.test(mapping.VirtualName ?? ''),
    ) ||
    new Set(image.BlockDeviceMappings.map((mapping) => mapping.DeviceName)).size !==
      image.BlockDeviceMappings.length ||
    new Set(ephemeralMappings.map((mapping) => mapping.VirtualName)).size !== ephemeralMappings.length
  )
    throw refused(
      `the AMI must be a Canonical Ubuntu 24.04 ${ec2.architecture} HVM/EBS server image with one root EBS disk that fits volumeGiB; additional mappings must be ephemeral instance-store devices`,
    );

  const vpcs = await cli.callAs(
    ['ec2', 'describe-vpcs', '--vpc-ids', ec2.vpcId],
    z.looseObject({
      Vpcs: z.array(z.looseObject({ VpcId: z.string(), OwnerId: z.string(), State: z.string() })),
    }),
  );
  if (
    vpcs.Vpcs.length !== 1 ||
    vpcs.Vpcs[0]?.VpcId !== ec2.vpcId ||
    vpcs.Vpcs[0].OwnerId !== account ||
    vpcs.Vpcs[0].State !== 'available'
  )
    throw refused('the VPC must be available in the central account');
  const dns = await cli.callAs(
    ['ec2', 'describe-vpc-attribute', '--vpc-id', ec2.vpcId, '--attribute', 'enableDnsSupport'],
    z.looseObject({ EnableDnsSupport: z.looseObject({ Value: z.boolean() }) }),
  );
  if (!dns.EnableDnsSupport.Value) throw refused('the VPC must have DNS support enabled');
  const subnets = await cli.callAs(
    ['ec2', 'describe-subnets', '--filters', `Name=vpc-id,Values=${ec2.vpcId}`],
    z.looseObject({ Subnets: z.array(subnetSchema) }),
  );
  if (catalogue)
    for (const subnet of subnets.Subnets)
      context.report.line(
        `available subnet: ${subnet.SubnetId} ${subnet.AvailabilityZone}, VPC ${subnet.VpcId}, state ${subnet.State}`,
      );
  const subnet = subnets.Subnets.find((subnet) => subnet.SubnetId === ec2.subnetId);
  if (
    !subnet ||
    subnet.VpcId !== ec2.vpcId ||
    subnet.OwnerId !== account ||
    subnet.State !== 'available' ||
    subnet.AvailableIpAddressCount < 1
  )
    throw refused(
      'the subnet must belong to the selected VPC and central account, be available and have a free IPv4 address',
    );
  const tables = await cli.callAs(
    ['ec2', 'describe-route-tables', '--filters', `Name=vpc-id,Values=${ec2.vpcId}`],
    z.looseObject({
      RouteTables: z.array(
        z.looseObject({
          OwnerId: z.string(),
          VpcId: z.string(),
          Associations: z.array(
            z.looseObject({
              SubnetId: z.string().optional(),
              Main: z.boolean().optional(),
              AssociationState: z.looseObject({ State: z.string() }).optional(),
            }),
          ),
          Routes: z.array(
            z.looseObject({
              DestinationCidrBlock: z.string().optional(),
              GatewayId: z.string().optional(),
              State: z.string(),
            }),
          ),
        }),
      ),
    }),
  );
  if (tables.RouteTables.some((table) => table.OwnerId !== account || table.VpcId !== ec2.vpcId))
    throw refused('the route table owner or VPC differs from the central account target');
  const explicit = tables.RouteTables.filter((table) =>
    table.Associations.some((association) => association.SubnetId === ec2.subnetId),
  );
  const effective = explicit.length
    ? explicit
    : tables.RouteTables.filter((table) => table.Associations.some((association) => association.Main));
  const route = effective[0]?.Routes.find((route) => route.DestinationCidrBlock === '0.0.0.0/0');
  if (effective.length !== 1 || !route?.GatewayId?.startsWith('igw-') || route.State !== 'active')
    throw refused(
      'the subnet needs an active direct IPv4 default route to an internet gateway; no NAT is created',
    );
  const gateways = await cli.callAs(
    ['ec2', 'describe-internet-gateways', '--internet-gateway-ids', route.GatewayId],
    z.looseObject({
      InternetGateways: z.array(
        z.looseObject({
          OwnerId: z.string(),
          InternetGatewayId: z.string(),
          Attachments: z.array(z.looseObject({ VpcId: z.string(), State: z.string() })),
        }),
      ),
    }),
  );
  if (
    gateways.InternetGateways.length !== 1 ||
    gateways.InternetGateways[0]?.OwnerId !== account ||
    gateways.InternetGateways[0].InternetGatewayId !== route.GatewayId ||
    !gateways.InternetGateways[0]?.Attachments.some(
      (attachment) => attachment.VpcId === ec2.vpcId && attachment.State === 'available',
    )
  )
    throw refused('the internet gateway must be attached to the selected VPC');
  const acls = await cli.callAs(
    ['ec2', 'describe-network-acls', '--filters', `Name=association.subnet-id,Values=${ec2.subnetId}`],
    z.looseObject({
      NetworkAcls: z.array(
        z.looseObject({
          OwnerId: z.string(),
          VpcId: z.string(),
          Entries: z.array(
            z.looseObject({
              Egress: z.boolean(),
              RuleNumber: z.number(),
              RuleAction: z.string(),
              Protocol: z.string(),
              CidrBlock: z.string().optional(),
            }),
          ),
        }),
      ),
    }),
  );
  if (
    acls.NetworkAcls.length !== 1 ||
    acls.NetworkAcls[0]?.OwnerId !== account ||
    acls.NetworkAcls[0].VpcId !== ec2.vpcId ||
    ![false, true].every((egress) => {
      const first = acls.NetworkAcls[0]!.Entries.filter(
        (entry) => entry.Egress === egress && entry.CidrBlock,
      ).sort((a, b) => a.RuleNumber - b.RuleNumber)[0];
      return first?.RuleAction === 'allow' && first.Protocol === '-1' && first.CidrBlock === '0.0.0.0/0';
    })
  )
    throw refused(
      'internet reachability requires an IPv4 allow-all network ACL in both directions; custom ACLs need owner review (the security group still has no inbound rules)',
    );

  const types = await cli.callAs(
    ['ec2', 'describe-instance-types', '--instance-types', ec2.instanceType],
    z.looseObject({
      InstanceTypes: z.array(
        z.looseObject({
          InstanceType: z.string(),
          ProcessorInfo: z.looseObject({ SupportedArchitectures: z.array(z.string()) }),
          SupportedVirtualizationTypes: z.array(z.string()),
          EbsInfo: z.looseObject({ EncryptionSupport: z.string() }),
        }),
      ),
    }),
  );
  const type = types.InstanceTypes[0];
  if (
    types.InstanceTypes.length !== 1 ||
    type?.InstanceType !== ec2.instanceType ||
    !type.ProcessorInfo.SupportedArchitectures.includes(ec2.architecture) ||
    !type.SupportedVirtualizationTypes.includes('hvm') ||
    type.EbsInfo.EncryptionSupport !== 'supported'
  )
    throw refused(`the instance type must support ${ec2.architecture} HVM and encrypted EBS`);
  const offerings = await cli.callAs(
    [
      'ec2',
      'describe-instance-type-offerings',
      '--location-type',
      'availability-zone',
      '--filters',
      `Name=instance-type,Values=${ec2.instanceType}`,
      `Name=location,Values=${subnet.AvailabilityZone}`,
    ],
    z.looseObject({
      InstanceTypeOfferings: z.array(z.looseObject({ InstanceType: z.string(), Location: z.string() })),
    }),
  );
  if (
    !offerings.InstanceTypeOfferings.some(
      (offering) =>
        offering.InstanceType === ec2.instanceType && offering.Location === subnet.AvailabilityZone,
    )
  )
    throw refused('the selected instance type is not offered in the subnet availability zone');
  context.report.step(
    'ok',
    'ec2-environment',
    `${ec2.amiId}, ${ec2.vpcId}/${ec2.subnetId}, ${subnet.AvailabilityZone}, direct public IPv4 egress`,
  );
  return image;
}

function validTrust(document: unknown): boolean {
  let value = document;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(decodeURIComponent(value));
    } catch {
      return false;
    }
  }
  const action = z.union([z.literal('sts:AssumeRole'), z.tuple([z.literal('sts:AssumeRole')])]);
  const service = z.union([z.literal('ec2.amazonaws.com'), z.tuple([z.literal('ec2.amazonaws.com')])]);
  const statement = z.strictObject({
    Effect: z.literal('Allow'),
    Principal: z.strictObject({ Service: service }),
    Action: action,
    Sid: z.string().optional(),
  });
  return z
    .strictObject({ Version: z.literal('2012-10-17'), Statement: z.union([statement, z.tuple([statement])]) })
    .safeParse(value).success;
}
async function findInstance(context: CloudContext, cli: AwsCli, account: string): Promise<Instance | null> {
  // Search by Name alone so an unowned resource cannot be hidden by a managed-tag filter.
  const answer = await cli.callAs(
    ['ec2', 'describe-instances', '--filters', `Name=tag:Name,Values=${context.config.aws.instanceName}`],
    z.looseObject({
      Reservations: z.array(z.looseObject({ OwnerId: z.string(), Instances: z.array(instanceSchema) })),
    }),
  );
  if (answer.Reservations.some((reservation) => reservation.OwnerId !== account))
    throw refused('the EC2 reservation owner differs from the STS central account');
  const matches = answer.Reservations.flatMap((reservation) => reservation.Instances);
  if (matches.length > 1)
    throw refused('multiple EC2 instances have the configured Name; no resource is changed');
  return matches[0] ?? null;
}
async function inspectInstance(
  context: CloudContext,
  cli: AwsCli,
  account: string,
  resources: Resources,
  rootName: string,
) {
  const { instance, group, role, profile } = resources;
  if (!instance) return;
  const ec2 = desired(context);
  if (
    !managed(instance.Tags, context.config.aws.instanceName) ||
    !['pending', 'running', 'stopping', 'stopped'].includes(instance.State.Name) ||
    instance.ImageId !== ec2.amiId ||
    instance.InstanceType !== ec2.instanceType ||
    instance.VpcId !== ec2.vpcId ||
    instance.SubnetId !== ec2.subnetId ||
    instance.Architecture !== ec2.architecture ||
    instance.VirtualizationType !== 'hvm' ||
    instance.RootDeviceType !== 'ebs' ||
    instance.RootDeviceName !== rootName ||
    instance.InstanceLifecycle ||
    !group ||
    !role ||
    !profile ||
    profile.Roles.length !== 1 ||
    instance.IamInstanceProfile?.Arn !== profileArn(context, account) ||
    instance.SecurityGroups.length !== 1 ||
    instance.SecurityGroups[0]?.GroupId !== group.GroupId ||
    instance.NetworkInterfaces.length !== 1 ||
    instance.NetworkInterfaces[0]?.Groups.length !== 1 ||
    instance.NetworkInterfaces[0]?.Groups[0]?.GroupId !== group.GroupId ||
    instance.MetadataOptions.HttpTokens !== 'required' ||
    instance.MetadataOptions.HttpPutResponseHopLimit !== 1 ||
    instance.MetadataOptions.HttpEndpoint !== 'enabled'
  )
    throw refused(
      'the existing EC2 instance differs in ownership, state, image, type, network, role or IMDS; no automatic repair or second instance',
    );
  if (instance.State.Name === 'pending') return; // Disk attachments are checked when the launch reaches running.
  if (instance.State.Name === 'running' && !instance.PublicIpAddress)
    throw refused('the running EC2 instance has no public IPv4 for outbound access');
  if (
    instance.BlockDeviceMappings.length !== 1 ||
    instance.BlockDeviceMappings[0]?.DeviceName !== rootName ||
    !instance.BlockDeviceMappings[0].Ebs.DeleteOnTermination
  )
    throw refused('the existing EC2 instance must have exactly the configured root EBS disk');
  const volumeId = instance.BlockDeviceMappings[0].Ebs.VolumeId;
  const volumes = await cli.callAs(
    ['ec2', 'describe-volumes', '--volume-ids', volumeId],
    z.looseObject({
      Volumes: z.array(
        z.looseObject({
          VolumeId: z.string(),
          VolumeType: z.string(),
          Size: z.number(),
          Encrypted: z.boolean(),
          Iops: z.number(),
          Throughput: z.number(),
          Tags: TAGS.optional(),
          Attachments: z.array(z.looseObject({ InstanceId: z.string(), Device: z.string() })),
        }),
      ),
    }),
  );
  const volume = volumes.Volumes[0];
  if (
    volumes.Volumes.length !== 1 ||
    volume?.VolumeId !== volumeId ||
    volume.VolumeType !== 'gp3' ||
    volume.Size !== ec2.volumeGiB ||
    !volume.Encrypted ||
    volume.Iops !== 3000 ||
    volume.Throughput !== 125 ||
    !managed(volume.Tags, context.config.aws.instanceName) ||
    volume.Attachments.length !== 1 ||
    volume.Attachments[0]?.InstanceId !== instance.InstanceId ||
    volume.Attachments[0].Device !== rootName
  )
    throw refused(
      'the root EBS disk differs in ownership, size, encryption, type or performance; no automatic repair',
    );
  const protection = await cli.callAs(
    [
      'ec2',
      'describe-instance-attribute',
      '--instance-id',
      instance.InstanceId,
      '--attribute',
      'disableApiTermination',
    ],
    z.looseObject({ DisableApiTermination: z.looseObject({ Value: z.boolean() }) }),
  );
  const shutdown = await cli.callAs(
    [
      'ec2',
      'describe-instance-attribute',
      '--instance-id',
      instance.InstanceId,
      '--attribute',
      'instanceInitiatedShutdownBehavior',
    ],
    z.looseObject({ InstanceInitiatedShutdownBehavior: z.looseObject({ Value: z.string() }) }),
  );
  if (!protection.DisableApiTermination.Value || shutdown.InstanceInitiatedShutdownBehavior.Value !== 'stop')
    throw refused('the existing EC2 instance must have termination protection and shutdown=stop');
}
async function inspect(
  context: CloudContext,
  cli: AwsCli,
  account: string,
  rootName: string,
): Promise<Resources> {
  const name = context.config.aws.instanceName;
  const groups = await cli.callAs(
    ['ec2', 'describe-security-groups', '--filters', `Name=group-name,Values=${name}-cloud`],
    z.looseObject({ SecurityGroups: z.array(groupSchema) }),
  );
  if (groups.SecurityGroups.length > 1) throw refused('multiple security groups have the configured name');
  const group = groups.SecurityGroups[0] ?? null;
  if (
    group &&
    (group.GroupName !== `${name}-cloud` ||
      group.OwnerId !== account ||
      group.VpcId !== desired(context).vpcId ||
      !managed(group.Tags, `${name}-cloud`) ||
      group.IpPermissions.length !== 0 ||
      !group.IpPermissionsEgress.some(
        (permission) =>
          permission.IpProtocol === '-1' &&
          permission.IpRanges?.some((range) => range.CidrIp === '0.0.0.0/0'),
      ))
  )
    throw refused(
      'the security group has foreign ownership, another VPC, inbound rules or lacks IPv4 egress; no automatic repair',
    );
  const roleAnswer = await cli.callAsOrNull(
    ['iam', 'get-role', '--role-name', hostName(context)],
    ['NoSuchEntity'],
    z.looseObject({ Role: roleSchema }),
  );
  const role = roleAnswer?.Role ?? null;
  if (role) {
    if (
      role.RoleName !== hostName(context) ||
      role.Arn !== `arn:aws:iam::${account}:role/${hostName(context)}` ||
      !managed(role.Tags, hostName(context)) ||
      !validTrust(role.AssumeRolePolicyDocument)
    )
      throw refused('the host role has foreign ownership or a trust policy other than EC2');
    const inline = await cli.callAs(
      ['iam', 'list-role-policies', '--role-name', hostName(context)],
      z.looseObject({ PolicyNames: z.array(z.string()) }),
    );
    const attached = await cli.callAs(
      ['iam', 'list-attached-role-policies', '--role-name', hostName(context)],
      z.looseObject({ AttachedPolicies: z.array(z.looseObject({ PolicyArn: z.string() })) }),
    );
    if (
      inline.PolicyNames.length ||
      attached.AttachedPolicies.some((policy) => policy.PolicyArn !== SSM_POLICY)
    )
      throw refused('the host role may only have AmazonSSMManagedInstanceCore and no inline policy');
  }
  const profileAnswer = await cli.callAsOrNull(
    ['iam', 'get-instance-profile', '--instance-profile-name', hostName(context)],
    ['NoSuchEntity'],
    z.looseObject({ InstanceProfile: profileSchema }),
  );
  const profile = profileAnswer?.InstanceProfile ?? null;
  if (
    profile &&
    (profile.InstanceProfileName !== hostName(context) ||
      profile.Arn !== profileArn(context, account) ||
      !managed(profile.Tags, hostName(context)) ||
      profile.Roles.length > 1 ||
      profile.Roles.some((item) => item.Arn !== `arn:aws:iam::${account}:role/${hostName(context)}`))
  )
    throw refused('the instance profile has foreign ownership or another role');
  const instance = await findInstance(context, cli, account);
  const resources = { group, role, profile, instance };
  await inspectInstance(context, cli, account, resources, rootName);
  return resources;
}

export async function ec2Preflight(context: CloudContext, cli: AwsCli, account: string): Promise<void> {
  const image = await environment(context, cli, account, true);
  await inspect(context, cli, account, image.RootDeviceName);
  costPreview(context);
}

async function ensureHostRole(context: CloudContext, cli: AwsCli, account: string, resources: Resources) {
  const name = hostName(context);
  if (!resources.role) {
    const answer = await cli.callAs(
      [
        'iam',
        'create-role',
        '--role-name',
        name,
        '--assume-role-policy-document',
        JSON.stringify(trust),
        '--tags',
        JSON.stringify(tags(name)),
      ],
      z.looseObject({ Role: roleSchema }),
    );
    resources.role = answer.Role;
  }
  const attached = await cli.callAs(
    ['iam', 'list-attached-role-policies', '--role-name', name],
    z.looseObject({ AttachedPolicies: z.array(z.looseObject({ PolicyArn: z.string() })) }),
  );
  if (attached.AttachedPolicies.some((policy) => policy.PolicyArn !== SSM_POLICY))
    throw refused('unexpected attached host role policy');
  if (!attached.AttachedPolicies.some((policy) => policy.PolicyArn === SSM_POLICY))
    await cli.call(['iam', 'attach-role-policy', '--role-name', name, '--policy-arn', SSM_POLICY]);
  if (!resources.profile) {
    const answer = await cli.callAs(
      [
        'iam',
        'create-instance-profile',
        '--instance-profile-name',
        name,
        '--tags',
        JSON.stringify(tags(name)),
      ],
      z.looseObject({ InstanceProfile: profileSchema }),
    );
    resources.profile = answer.InstanceProfile;
  }
  if (resources.profile.Arn !== profileArn(context, account))
    throw refused('unexpected instance profile account');
  if (!resources.profile.Roles.length)
    await cli.call([
      'iam',
      'add-role-to-instance-profile',
      '--instance-profile-name',
      name,
      '--role-name',
      name,
    ]);
  context.report.step('ok', 'ec2-host-role', `${name}, EC2 trust, AmazonSSMManagedInstanceCore`);
}

async function waitForInstance(
  context: CloudContext,
  cli: AwsCli,
  account: string,
  rootName: string,
): Promise<Resources> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const resources = await inspect(context, cli, account, rootName);
    if (resources.instance && resources.instance.State.Name !== 'pending') return resources;
    await context.deps.sleep(5_000);
  }
  throw new CloudError(
    'the EC2 instance did not become visible and leave pending in time; rerun to rediscover it',
  );
}

/** Creates only missing, named resources. An interrupted launch can be rediscovered without a local state file. */
export async function runEc2(
  context: CloudContext,
  cli: AwsCli,
  account: string,
  dryRun: boolean,
): Promise<void> {
  const ec2 = desired(context);
  const image = await environment(context, cli, account, false);
  let resources = await inspect(context, cli, account, image.RootDeviceName);
  costPreview(context);
  if (dryRun) {
    context.report.step(
      'skipped',
      'ec2',
      `dry-run: ${resources.instance ? 'keep the existing' : 'would create one'} ${ec2.instanceType}; security group with no inbound rules, EC2 host role and instance profile`,
    );
    return;
  }
  // Existing pending launches must reveal their disk/protection before any missing IAM policy is attached.
  if (resources.instance?.State.Name === 'pending')
    resources = await waitForInstance(context, cli, account, image.RootDeviceName);
  await ensureHostRole(context, cli, account, resources);
  let createdGroupId: string | undefined;
  if (!resources.group) {
    const name = `${context.config.aws.instanceName}-cloud`;
    const result = await cli.callAs(
      [
        'ec2',
        'create-security-group',
        '--group-name',
        name,
        '--description',
        'Projectman cloud: outbound only',
        '--vpc-id',
        ec2.vpcId,
        '--tag-specifications',
        JSON.stringify([{ ResourceType: 'security-group', Tags: tags(name) }]),
      ],
      z.looseObject({ GroupId: z.string() }),
    );
    createdGroupId = result.GroupId;
    context.report.step('created', 'ec2-security-group', `${result.GroupId}, no inbound rules`);
  }
  // Recheck after partial creation and before RunInstances. Never launch next to a machine created by another run.
  let checked = await inspect(context, cli, account, image.RootDeviceName);
  if (createdGroupId) {
    for (let attempt = 0; !checked.group && attempt < 7; attempt += 1) {
      await context.deps.sleep(Math.min(2_000 * 2 ** attempt, 30_000));
      checked = await inspect(context, cli, account, image.RootDeviceName);
    }
    if (!checked.group)
      throw new CloudError(
        'the new EC2 security group is not visible yet; rerun to rediscover it before launching an instance',
      );
    if (checked.group.GroupId !== createdGroupId)
      throw refused('the security group name now points to a different group than the one just created');
  }
  if (!checked.group)
    throw refused('the EC2 security group disappeared before launch; no instance is created');
  let instance = checked.instance;
  if (!instance) {
    const userData = fs.readFileSync(path.join(context.deps.repoRoot, 'deploy/aws/ec2-bootstrap.sh'), 'utf8');
    const request = {
      ImageId: ec2.amiId,
      InstanceType: ec2.instanceType,
      MinCount: 1,
      MaxCount: 1,
      NetworkInterfaces: [
        {
          DeviceIndex: 0,
          SubnetId: ec2.subnetId,
          Groups: [checked.group.GroupId],
          AssociatePublicIpAddress: true,
          DeleteOnTermination: true,
        },
      ],
      IamInstanceProfile: { Name: hostName(context) },
      BlockDeviceMappings: [
        {
          DeviceName: image.RootDeviceName,
          Ebs: {
            VolumeSize: ec2.volumeGiB,
            VolumeType: 'gp3',
            Encrypted: true,
            Iops: 3000,
            Throughput: 125,
            DeleteOnTermination: true,
          },
        },
      ],
      MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1, HttpEndpoint: 'enabled' },
      DisableApiTermination: true,
      InstanceInitiatedShutdownBehavior: 'stop',
      TagSpecifications: ['instance', 'volume', 'network-interface'].map((ResourceType) => ({
        ResourceType,
        Tags: tags(context.config.aws.instanceName),
      })),
      ...(/^t\d+[a-z]*\./.test(ec2.instanceType) ? { CreditSpecification: { CpuCredits: 'standard' } } : {}),
      // AWS CLI's RunInstances handler base64-encodes UserData, including --cli-input-json values.
      UserData: userData,
    };
    // The namespace and complete public desired request make retries stable, including after a CLI timeout.
    const token = createHash('sha256')
      .update(
        JSON.stringify({
          namespace: 'projectman-ec2-v1',
          account,
          region: context.config.aws.region,
          name: context.config.aws.instanceName,
          request,
        }),
      )
      .digest('hex');
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const result = await cli.callAs(
          ['ec2', 'run-instances', '--cli-input-json', JSON.stringify({ ...request, ClientToken: token })],
          z.looseObject({ Instances: z.array(z.looseObject({ InstanceId: z.string() })).length(1) }),
        );
        context.report.step('created', 'ec2-instance', result.Instances[0]!.InstanceId);
        break;
      } catch (error) {
        // IAM profiles and security groups propagate asynchronously. Retries keep the same ClientToken/request.
        if (
          !(error instanceof AwsCallError) ||
          !(
            error.awsCode === 'InvalidGroup.NotFound' ||
            (error.awsCode === 'InvalidParameterValue' &&
              error.message.includes('Invalid IAM Instance Profile'))
          ) ||
          attempt === 11
        )
          throw error;
        await context.deps.sleep(5_000);
      }
    }
  }
  instance = (await waitForInstance(context, cli, account, image.RootDeviceName)).instance!;
  context.report.step(
    'unchanged',
    'ec2-instance',
    `${instance.InstanceId}, ${instance.State.Name}, ${ec2.instanceType}; no inbound port`,
  );
}
