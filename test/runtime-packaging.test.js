import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('container runtime provides a bounded non-networked Xvfb display', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const launcher = await readFile(new URL('../scripts/run-with-xvfb.mjs', import.meta.url), 'utf8');

  assert.match(dockerfile, /apk add --no-cache chromium xvfb/);
  assert.match(dockerfile, /chmod 1777 \/tmp\/\.X11-unix/);
  assert.match(dockerfile, /ENV DISPLAY=:99/);
  assert.match(dockerfile, /ENTRYPOINT \["node", "scripts\/run-with-xvfb\.mjs"\]/);
  assert.doesNotMatch(dockerfile, /xvfb-run|--no-sandbox|--disable-gpu-sandbox/);
  assert.match(launcher, /'-nolisten', 'tcp'/);
  assert.match(launcher, /await access\(socket\)/);
  assert.match(launcher, /child\.kill\(signal\)/);
  assert.match(launcher, /xvfb\.kill\('SIGTERM'\)/);
  assert.match(launcher, /xvfb\.kill\('SIGKILL'\)/);
});
