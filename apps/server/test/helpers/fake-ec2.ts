/** A stateful EC2/host-IAM CLI fake. It survives command restarts and never contacts AWS. */
import type { RunResult } from '../../../../scripts/cloud/deps';

const ok = (value: unknown = {}): RunResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const missing = (): RunResult => ({
  code: 254,
  stdout: '',
  stderr: 'An error occurred (NoSuchEntity) when calling IAM: missing',
});
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
const managedTags = (name: string) => [
  { Key: 'Name', Value: name },
  { Key: 'ProjectmanManaged', Value: 'true' },
];
export const EC2_CONFIG = {
  instanceType: 't3.small',
  amiId: 'ami-0123456789abcdef0',
  vpcId: 'vpc-0123456789abcdef0',
  subnetId: 'subnet-0123456789abcdef0',
  volumeGiB: 40,
};

export class FakeEc2 {
  image = {
    ImageId: EC2_CONFIG.amiId,
    OwnerId: '099720109477',
    Name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20261001',
    State: 'available',
    Architecture: 'x86_64',
    VirtualizationType: 'hvm',
    RootDeviceType: 'ebs',
    RootDeviceName: '/dev/sda1',
    BlockDeviceMappings: [
      { DeviceName: '/dev/sda1', Ebs: { VolumeSize: 8 } },
      { DeviceName: '/dev/sdb', VirtualName: 'ephemeral0' },
      { DeviceName: '/dev/sdc', VirtualName: 'ephemeral1' },
    ],
    ProductCodes: [] as unknown[],
  };
  subnet = {
    SubnetId: EC2_CONFIG.subnetId,
    VpcId: EC2_CONFIG.vpcId,
    AvailabilityZone: 'eu-west-1b',
    State: 'available',
    AvailableIpAddressCount: 200,
  };
  route = { DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-0123456789abcdef0', State: 'active' };
  dnsSupport = true;
  gatewayAttached = true;
  offerings = true;
  architecture = 'x86_64';
  reservationOwner: string | null = null;
  networkOwner: string | null = null;
  aclAllowsInternet = true;
  groups: Record<string, any>[] = [];
  role: Record<string, any> | null = null;
  profile: Record<string, any> | null = null;
  attached: string[] = [];
  inline: string[] = [];
  instances: Record<string, any>[] = [];
  volume: Record<string, any> | null = null;
  terminationProtection = true;
  shutdown = 'stop';
  request: Record<string, any> | null = null;
  tokens = new Map<string, string>();
  pendingPolls = 0;
  profilePropagationFailures = 0;
  groupVisibilityPolls = 0;
  groupPropagationFailures = 0;
  /** Simulates the response getting lost after RunInstances succeeded at AWS. */
  loseLaunchResponse = false;
  /** An operation that fails before mutating, once. */
  failOnce: string | null = null;

  handles(args: string[]) {
    return args[0] === 'ec2' || (args[0] === 'iam' && /role|instance-profile/.test(args[1]!));
  }
  run(args: string[], account: string): RunResult {
    const operation = args[1]!;
    if (this.failOnce === operation) {
      this.failOnce = null;
      return {
        code: 254,
        stdout: '',
        stderr: 'An error occurred (InternalFailure) when calling AWS: injected failure',
      };
    }
    const hostName = 'projectman-cloud-host';
    switch (operation) {
      case 'describe-regions':
        return ok({ Regions: [{ RegionName: 'eu-west-1', OptInStatus: 'opt-in-not-required' }] });
      case 'describe-images':
        return ok({ Images: [this.image] });
      case 'describe-vpcs':
        return ok({ Vpcs: [{ VpcId: EC2_CONFIG.vpcId, OwnerId: account, State: 'available' }] });
      case 'describe-vpc-attribute':
        return ok({ EnableDnsSupport: { Value: this.dnsSupport } });
      case 'describe-subnets':
        return ok({ Subnets: [{ ...this.subnet, OwnerId: account }] });
      case 'describe-route-tables':
        return ok({
          RouteTables: [
            {
              OwnerId: this.networkOwner ?? account,
              VpcId: EC2_CONFIG.vpcId,
              Associations: [{ SubnetId: EC2_CONFIG.subnetId }],
              Routes: [this.route],
            },
          ],
        });
      case 'describe-internet-gateways':
        return ok({
          InternetGateways: [
            {
              OwnerId: this.networkOwner ?? account,
              InternetGatewayId: this.route.GatewayId,
              Attachments: this.gatewayAttached ? [{ VpcId: EC2_CONFIG.vpcId, State: 'available' }] : [],
            },
          ],
        });
      case 'describe-network-acls':
        return ok({
          NetworkAcls: [
            {
              OwnerId: this.networkOwner ?? account,
              VpcId: EC2_CONFIG.vpcId,
              Entries: [false, true].map((Egress) => ({
                Egress,
                RuleNumber: 100,
                RuleAction: this.aclAllowsInternet ? 'allow' : 'deny',
                Protocol: '-1',
                CidrBlock: '0.0.0.0/0',
              })),
            },
          ],
        });
      case 'describe-instance-types':
        return ok({
          InstanceTypes: [
            {
              InstanceType: EC2_CONFIG.instanceType,
              ProcessorInfo: { SupportedArchitectures: [this.architecture] },
              SupportedVirtualizationTypes: ['hvm'],
              EbsInfo: { EncryptionSupport: 'supported' },
            },
          ],
        });
      case 'describe-instance-type-offerings':
        return ok({
          InstanceTypeOfferings: this.offerings
            ? [{ InstanceType: EC2_CONFIG.instanceType, Location: this.subnet.AvailabilityZone }]
            : [],
        });
      case 'describe-security-groups':
        if (this.groups.length && this.groupVisibilityPolls > 0) {
          this.groupVisibilityPolls -= 1;
          return ok({ SecurityGroups: [] });
        }
        return ok({ SecurityGroups: this.groups });
      case 'create-security-group': {
        const name = flag(args, '--group-name');
        this.groups.push({
          GroupId: 'sg-0123456789abcdef0',
          GroupName: name,
          VpcId: flag(args, '--vpc-id'),
          OwnerId: account,
          Tags: JSON.parse(flag(args, '--tag-specifications'))[0].Tags,
          IpPermissions: [],
          IpPermissionsEgress: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }],
        });
        return ok({ GroupId: this.groups[0]!.GroupId });
      }
      case 'get-role':
        return this.role ? ok({ Role: this.role }) : missing();
      case 'create-role': {
        const name = flag(args, '--role-name');
        this.role = {
          RoleName: name,
          Arn: `arn:aws:iam::${account}:role/${name}`,
          Tags: JSON.parse(flag(args, '--tags')),
          AssumeRolePolicyDocument: JSON.parse(flag(args, '--assume-role-policy-document')),
        };
        return ok({ Role: this.role });
      }
      case 'list-role-policies':
        return ok({ PolicyNames: this.inline });
      case 'list-attached-role-policies':
        return ok({ AttachedPolicies: this.attached.map((PolicyArn) => ({ PolicyArn })) });
      case 'attach-role-policy':
        this.attached.push(flag(args, '--policy-arn'));
        return ok();
      case 'get-instance-profile':
        return this.profile ? ok({ InstanceProfile: this.profile }) : missing();
      case 'create-instance-profile': {
        const name = flag(args, '--instance-profile-name');
        this.profile = {
          InstanceProfileName: name,
          Arn: `arn:aws:iam::${account}:instance-profile/${name}`,
          Tags: JSON.parse(flag(args, '--tags')),
          Roles: [],
        };
        return ok({ InstanceProfile: this.profile });
      }
      case 'add-role-to-instance-profile':
        this.profile!.Roles = [this.role!];
        return ok();
      case 'describe-instances': {
        if (this.pendingPolls > 0) this.pendingPolls -= 1;
        else
          for (const instance of this.instances)
            if (instance.State.Name === 'pending') instance.State.Name = 'running';
        return ok({
          Reservations: [{ OwnerId: this.reservationOwner ?? account, Instances: this.instances }],
        });
      }
      case 'run-instances': {
        this.request = JSON.parse(flag(args, '--cli-input-json'));
        if (this.groupPropagationFailures > 0) {
          this.groupPropagationFailures -= 1;
          return {
            code: 254,
            stdout: '',
            stderr: 'An error occurred (InvalidGroup.NotFound) when calling RunInstances: group not found',
          };
        }
        if (this.profilePropagationFailures > 0) {
          this.profilePropagationFailures -= 1;
          return {
            code: 254,
            stdout: '',
            stderr:
              'An error occurred (InvalidParameterValue) when calling RunInstances: Invalid IAM Instance Profile name',
          };
        }
        const request = this.request!;
        const known = this.tokens.get(request.ClientToken);
        if (known) return ok({ Instances: [{ InstanceId: known }] });
        const id = 'i-0123456789abcdef0';
        this.tokens.set(request.ClientToken, id);
        this.instances.push({
          InstanceId: id,
          ImageId: request.ImageId,
          InstanceType: request.InstanceType,
          VpcId: EC2_CONFIG.vpcId,
          SubnetId: request.NetworkInterfaces[0].SubnetId,
          State: { Name: 'pending' },
          Tags: request.TagSpecifications.find((item: any) => item.ResourceType === 'instance').Tags,
          Architecture: 'x86_64',
          VirtualizationType: 'hvm',
          RootDeviceType: 'ebs',
          RootDeviceName: '/dev/sda1',
          MetadataOptions: request.MetadataOptions,
          SecurityGroups: request.NetworkInterfaces[0].Groups.map((GroupId: string) => ({ GroupId })),
          IamInstanceProfile: { Arn: `arn:aws:iam::${account}:instance-profile/${hostName}` },
          BlockDeviceMappings: [
            {
              DeviceName: '/dev/sda1',
              Ebs: {
                VolumeId: 'vol-0123456789abcdef0',
                DeleteOnTermination: request.BlockDeviceMappings[0].Ebs.DeleteOnTermination,
              },
            },
          ],
          NetworkInterfaces: [
            {
              NetworkInterfaceId: 'eni-0123456789abcdef0',
              Groups: request.NetworkInterfaces[0].Groups.map((GroupId: string) => ({ GroupId })),
            },
          ],
          PublicIpAddress: '203.0.113.7',
        });
        this.volume = {
          VolumeId: 'vol-0123456789abcdef0',
          ...request.BlockDeviceMappings[0].Ebs,
          Size: request.BlockDeviceMappings[0].Ebs.VolumeSize,
          Tags: managedTags('projectman-cloud'),
          Attachments: [{ InstanceId: id, Device: '/dev/sda1' }],
        };
        this.terminationProtection = request.DisableApiTermination;
        this.shutdown = request.InstanceInitiatedShutdownBehavior;
        if (this.loseLaunchResponse) {
          this.loseLaunchResponse = false;
          return { code: 124, stdout: '', stderr: 'timeout after launch' };
        }
        return ok({ Instances: [{ InstanceId: id }] });
      }
      case 'describe-volumes':
        return ok({ Volumes: this.volume ? [this.volume] : [] });
      case 'describe-instance-attribute':
        return flag(args, '--attribute') === 'disableApiTermination'
          ? ok({ DisableApiTermination: { Value: this.terminationProtection } })
          : ok({ InstanceInitiatedShutdownBehavior: { Value: this.shutdown } });
      default:
        return { code: 252, stdout: '', stderr: `fake EC2: unsupported ${operation}` };
    }
  }
}
