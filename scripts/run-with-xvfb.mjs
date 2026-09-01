import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const display = process.env.DISPLAY || ':99';
const match = /^:(\d+)$/.exec(display);
const command = process.argv.slice(2);

if (!match || !command.length) {
  console.error('Refloom display runtime failed.');
  process.exit(1);
}

const socket = `/tmp/.X11-unix/X${match[1]}`;
const xvfb = spawn('/usr/bin/Xvfb', [
  display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'
], { stdio: 'ignore' });

const exit = childProcess => new Promise(resolve => {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    resolve({ code: childProcess.exitCode, signal: childProcess.signalCode });
    return;
  }
  let settled = false;
  const finish = (code, signal) => {
    if (settled) return;
    settled = true;
    resolve({ code, signal });
  };
  childProcess.once('error', () => finish(1, null));
  childProcess.once('exit', finish);
});

async function waitForDisplay() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (xvfb.exitCode !== null || xvfb.signalCode !== null) throw new Error();
    try { await access(socket); return; } catch { /* Xvfb is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error();
}

async function stopXvfb() {
  if (xvfb.exitCode !== null || xvfb.signalCode !== null) return;
  xvfb.kill('SIGTERM');
  const stopped = await Promise.race([
    exit(xvfb).then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 1_000))
  ]);
  if (!stopped) {
    xvfb.kill('SIGKILL');
    await exit(xvfb);
  }
}

let child;
try {
  await waitForDisplay();
  child = spawn(command[0], command.slice(1), {
    stdio: 'inherit', env: { ...process.env, DISPLAY: display }
  });
  const forward = signal => () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const forwardTerm = forward('SIGTERM');
  const forwardInterrupt = forward('SIGINT');
  process.on('SIGTERM', forwardTerm);
  process.on('SIGINT', forwardInterrupt);
  const result = await exit(child);
  process.off('SIGTERM', forwardTerm);
  process.off('SIGINT', forwardInterrupt);
  process.exitCode = result.code ?? (result.signal ? 1 : 0);
} catch {
  console.error('Refloom display runtime failed.');
  process.exitCode = 1;
} finally {
  await stopXvfb();
}
