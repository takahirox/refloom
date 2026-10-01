import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const bridge = fileURLToPath(new URL('../scripts/visparse-bridge.py', import.meta.url));
export const digest = value => createHash('sha256').update(value).digest('hex');
export const analysisError = code => Object.assign(new Error(code), { code });

// The whole process group and its private temp directory belong to one invocation.
export async function runBridge({ python, args = [], input = '', env, signal, timeout = 310000 }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'refloom-analysis-'));
  try {
    return await new Promise((resolve, reject) => {
      let failure;
      let bytes = 0;
      const chunks = [];
      const child = spawn(python, [bridge, ...args], {
        cwd: directory, env: { ...env, TMPDIR: directory, TMP: directory, TEMP: directory, PYTHONDONTWRITEBYTECODE: '1' },
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']
      });
      const kill = code => {
        failure ??= analysisError(code);
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
      };
      const abort = () => kill('ANALYSIS_CANCELLED');
      const timer = setTimeout(() => kill('ANALYSIS_TIMEOUT'), timeout);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) kill('ANALYSIS_OUTPUT_LIMIT');
        else chunks.push(chunk);
      });
      let diagnostics = 0;
      child.stderr.on('data', chunk => { diagnostics += chunk.length; if (diagnostics > 1024 * 1024) kill('ANALYSIS_OUTPUT_LIMIT'); });
      child.stdin.on('error', () => {});
      child.on('error', () => { failure ??= analysisError('ANALYSIS_UNAVAILABLE'); });
      child.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        // Wrappers may leave descendants running even after their leader exits.
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch {}
        if (failure || code !== 0) return reject(failure ?? analysisError('ANALYSIS_FAILED'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(analysisError('ANALYSIS_INVALID_RESULT')); }
      });
      child.stdin.end(input);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function createVisparseRunner(env = process.env) {
  const enabled = env.REFLOOM_ANALYSIS_ENABLED === '1';
  const python = env.REFLOOM_VISPARSE_PYTHON || 'python3';
  const timeout = Number(env.REFLOOM_ANALYSIS_TIMEOUT_SECONDS || 300);
  const inherited = (env.REFLOOM_VISPARSE_INHERIT_ENV || '').split(',').map(s => s.trim()).filter(Boolean);
  const environmentNames = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', ...inherited]);
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => environmentNames.has(name)));
  const config = {
    agent: env.REFLOOM_VISPARSE_AGENT || 'codex',
    timeout_seconds: timeout,
    ...(env.REFLOOM_VISPARSE_EXECUTABLE ? { executable: env.REFLOOM_VISPARSE_EXECUTABLE } : {}),
    ...(env.REFLOOM_VISPARSE_MODEL ? { model: env.REFLOOM_VISPARSE_MODEL } : {})
  };
  const valid = Number.isFinite(timeout) && timeout >= 1 && timeout <= 900
    && (!config.model || /^\S+$/.test(config.model))
    && ['codex', 'command'].includes(config.agent) && (config.agent !== 'command' || !!config.executable);
  return {
    enabled: enabled && valid, inspectionEnabled: enabled, timeoutMs: (valid ? timeout : 300) * 1000 + 10000,
    configuration: digest(JSON.stringify({ adapter: 'refloom.visparse/1', python, config, inherited })),
    inspectionConfiguration: digest(JSON.stringify({ adapter: 'refloom.inspection/1', python })),
    settings: { adapter: 'refloom.visparse/1', timeoutSeconds: timeout, estimateGeometry: false, semanticExtraction: false, targetInputs: false },
    async info() {
      if (!enabled) throw analysisError('ANALYSIS_UNAVAILABLE');
      return runBridge({ python, args: ['info'], env: childEnv, timeout: 10000 });
    },
    async analyze(contents, intent, signal) {
      if (!enabled || !valid) throw analysisError('ANALYSIS_UNAVAILABLE');
      return runBridge({ python, env: childEnv, signal, timeout: timeout * 1000 + 10000,
        input: JSON.stringify({ image: contents.toString('base64'), intent, config }) });
    },
    async inspect(bundle, signal) {
      if (!enabled) throw analysisError('ANALYSIS_UNAVAILABLE');
      return runBridge({ python, env: childEnv, signal, timeout: 10000,
        input: JSON.stringify({ product: 'visparse.inspection', bundle }) });
    },
    producer: { agent: config.agent, requestedModel: config.model ?? null, resolvedModel: null }
  };
}
