import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_ERROR, isPublicAddress, normalizeCaptureUrl } from '../src/capture-url.js';

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

test('normalizes only conventional public HTTP URLs', async () => {
  const result = await normalizeCaptureUrl('HTTPS://Example.COM/a?b=1', { resolver: publicResolver });
  assert.equal(result.href, 'https://example.com/a?b=1');
  assert.equal(result.port, 443);
});

test('rejects ambiguous authority and URL forms', async () => {
  for (const input of [
    'file:///etc/passwd', 'https://user@example.com/', 'https://example.com/#x',
    'https://example.com:444/', 'http://example.com:443/', 'http://localhost/',
    'http://thing.localhost/', 'http://intranet/', 'http://example.com./'
  ]) await assert.rejects(normalizeCaptureUrl(input, { resolver: publicResolver }), { message: CAPTURE_ERROR });
});

test('classifies reserved IPv4 and IPv6 literals', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1',
    '172.16.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1',
    'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1'
  ]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('93.184.216.34'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('normalizes a public IPv6 literal and rejects alternate private IPv4 forms', async () => {
  const ipv6 = await normalizeCaptureUrl('https://[2606:4700:4700::1111]/');
  assert.equal(ipv6.hostname, '2606:4700:4700::1111');
  for (const input of ['http://127.1/', 'http://0x7f000001/', 'http://2130706433/']) {
    await assert.rejects(normalizeCaptureUrl(input), { message: CAPTURE_ERROR });
  }
});

test('requires every DNS answer to be public', async () => {
  const resolver = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 }
  ];
  await assert.rejects(normalizeCaptureUrl('https://example.com', { resolver }), { message: CAPTURE_ERROR });
});

test('loopback policy is explicit, HTTP-only, and limited to high development ports', async () => {
  const local = await normalizeCaptureUrl('http://localhost:5173/app', { policy: 'loopback' });
  assert.equal(local.href, 'http://localhost:5173/app');
  assert.deepEqual(local.answers, [{ address: '127.0.0.1', family: 4 }]);
  for (const input of [
    'http://localhost/', 'http://localhost:80/', 'https://localhost:5173/',
    'http://127.0.0.2:5173/', 'http://192.168.1.2:5173/',
    'http://example.com:5173/'
  ]) {
    await assert.rejects(normalizeCaptureUrl(input, { policy: 'loopback' }), { message: CAPTURE_ERROR });
  }
});

test('public policy still rejects loopback even on an allowed public port', async () => {
  await assert.rejects(normalizeCaptureUrl('http://127.0.0.1/', { policy: 'public' }), {
    message: CAPTURE_ERROR
  });
});
