import net from 'node:net';

/**
 * IPv4 ranges the egress proxy never connects to, whatever a name resolves to: this host,
 * private networks (the LAN, the Mac behind the NAT), shared address space (the tailnet),
 * link-local (cloud metadata), loopback, documentation, benchmarking, multicast and reserved.
 */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4ToInt(address: string): number {
  return address.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const BLOCKED = BLOCKED_V4.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: v4ToInt(base) & mask, mask };
});

/** Whether a destination address is public IPv4 (the only kind the proxy connects to). */
export function isPublicIPv4(address: string): boolean {
  if (net.isIPv4(address) === false) return false;
  const value = v4ToInt(address);
  return !BLOCKED.some(({ base, mask }) => (value & mask) === base);
}

/** Whether a host string is an IP address literal (IPv4 or IPv6). */
export function isIpLiteral(host: string): boolean {
  return net.isIP(host) !== 0;
}
