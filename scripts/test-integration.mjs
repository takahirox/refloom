import { spawn } from 'node:child_process';

const project = `refloom-integration-${process.pid}`;

function compose(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'compose', '-f', 'compose.yaml', '-f', 'compose.integration.yaml',
      '-p', project, ...args
    ], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`docker compose exited with ${signal ?? code}`));
    });
  });
}

let failure;
try {
  await compose([
    '--profile', 'integration', 'up', '--build', '--abort-on-container-exit',
    '--exit-code-from', 'integration', 'integration'
  ]);
} catch (error) {
  failure = error;
  try { await compose(['logs', '--no-color', '--tail', '200']); } catch {}
} finally {
  try { await compose(['down', '--volumes', '--remove-orphans']); }
  catch (error) { failure ??= error; }
}

if (failure) throw failure;
