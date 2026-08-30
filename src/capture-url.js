import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export const CAPTURE_ERROR = 'Website capture failed.';

function fail() {
  throw new Error(CAPTURE_ERROR);
}

function ipv4Number(address) {
  return address.split('.').reduce((value, part) => (value * 256) + Number(part), 0) >>> 0;
}

function inV4(address, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

function ipv6Number(address) {
  let value = address.toLowerCase().split('%')[0];
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    const v4 = ipv4Number(value.slice(separator + 1));
    value = `${value.slice(0, separator)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const sides = value.split('::');
  if (sides.length > 2) throw new TypeError('invalid IPv6');
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides[1] ? sides[1].split(':') : [];
  const groups = sides.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8) throw new TypeError('invalid IPv6');
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group || '0'}`), 0n);
}

function inV6(address, base, bits) {
  const shift = 128n - BigInt(bits);
  return ipv6Number(address) >> shift === ipv6Number(base) >> shift;
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    return ![
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
      ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
      ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
    ].some(([base, bits]) => inV4(address, base, bits));
  }
  if (family !== 6) return false;
  const value = address.toLowerCase().split('%')[0];
  return ![
    ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
    ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
    ['3fff::', 20], ['5f00::', 16], ['fc00::', 7], ['fe80::', 10],
    ['fec0::', 10], ['ff00::', 8]
  ].some(([base, bits]) => inV6(value, base, bits));
}

export async function resolvePublicHost(hostname, resolver = lookup) {
  let answers;
  try {
    answers = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await resolver(hostname, { all: true, verbatim: true });
  } catch {
    fail();
  }
  if (!Array.isArray(answers) || answers.length === 0 ||
      answers.some(answer => !answer || !isPublicAddress(answer.address))) fail();
  return answers.map(answer => ({ address: answer.address, family: isIP(answer.address) }));
}

export async function normalizeCaptureUrl(input, options = {}) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    fail();
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname.endsWith('.') ||
      hostname.toLowerCase() === 'localhost' ||
      hostname.toLowerCase().endsWith('.localhost') ||
      (!isIP(hostname) && !hostname.includes('.'))) fail();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (!['80', '443'].includes(port) ||
      (url.protocol === 'http:' && port !== '80') ||
      (url.protocol === 'https:' && port !== '443')) fail();
  url.username = '';
  url.password = '';
  url.hash = '';
  const answers = await resolvePublicHost(hostname, options.resolver);
  return { url, href: url.href, hostname, port: Number(port), answers };
}
