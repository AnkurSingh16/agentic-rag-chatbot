import { isIPv4, isIPv6 } from 'node:net';

function expandIPv6(address: string): string[] {
  const [head = '', tail] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(missing).fill('0'), ...right].map((group) =>
    group.toLowerCase().replace(/^0+(?=.)/, ''),
  );
}

/**
 * The key a client address is limited under (ADR 0004): IPv4 addresses as they are, IPv6
 * addresses by their /64 prefix so one host cannot rotate through its own prefix. IPv4-mapped
 * IPv6 addresses count as IPv4.
 */
export function ipKey(address: string): string {
  const unzoned = address.split('%')[0] ?? address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(unzoned)?.[1];
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  if (isIPv4(unzoned)) return unzoned;
  if (isIPv6(unzoned)) return `${expandIPv6(unzoned).slice(0, 4).join(':')}::/64`;
  return unzoned;
}
