"""Bounded Refloom adapter; all analysis semantics/validation belong to Visparse."""
import base64
import hashlib
import importlib.metadata
import json
import pathlib
import selectors
import subprocess
import sys
import time


class BoundedRunner:
    """Reuse Visparse's transport protocol while bounding provider output too."""
    def run(self, argv, *, timeout, input_text=None):
        from visparse.codex import ProcessResult
        with subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE) as process:
            streams = selectors.DefaultSelector()
            streams.register(process.stdout, selectors.EVENT_READ, 'stdout')
            streams.register(process.stderr, selectors.EVENT_READ, 'stderr')
            # Prompts can exceed pipe capacity: multiplex stdin with the readers.
            pending = memoryview((input_text or '').encode())
            if pending:
                streams.register(process.stdin, selectors.EVENT_WRITE, 'stdin')
            else:
                process.stdin.close()
            buffers = {'stdout': bytearray(), 'stderr': bytearray()}
            deadline = time.monotonic() + timeout
            try:
                while streams.get_map():
                    if time.monotonic() >= deadline:
                        raise subprocess.TimeoutExpired(argv, timeout)
                    for key, _ in streams.select(0.1):
                        if key.data == 'stdin':
                            import os
                            try:
                                count = os.write(key.fileobj.fileno(), pending[:4096])
                                pending = pending[count:]
                            except BrokenPipeError:
                                pending = b''
                            if not pending:
                                streams.unregister(key.fileobj)
                                key.fileobj.close()
                            continue
                        chunk = key.fileobj.read1(65536)
                        if not chunk:
                            streams.unregister(key.fileobj)
                            continue
                        buffers[key.data].extend(chunk)
                        if len(buffers[key.data]) > 1024 * 1024:
                            raise ValueError('provider output limit')
                process.wait(timeout=max(0.01, deadline - time.monotonic()))
                return ProcessResult(process.returncode, buffers['stdout'].decode(), buffers['stderr'].decode())
            finally:
                streams.close()
                if process.poll() is None:
                    process.kill()


def main():
    import visparse
    from visparse.agent_config import AnalyzerConfig
    from visparse.design import CodexDesignAnalyzer, run_design_analyzer, normalize_design_profile
    from visparse.model import SourceEvidence, MAX_INPUT_BYTES
    from visparse.contracts import load_json

    # Package releases currently share 0.1.0; bind reuse to the installed code too.
    root = pathlib.Path(visparse.__file__).parent
    digest = hashlib.sha256()
    for path in sorted(root.rglob('*.py')):
        digest.update(str(path.relative_to(root)).encode())
        digest.update(path.read_bytes())
    try:
        version = importlib.metadata.version('visparse')
    except importlib.metadata.PackageNotFoundError:
        version = 'source'
    identity = version + ':' + digest.hexdigest()
    if sys.argv[1:] == ['info']:
        print(json.dumps({'version': identity}))
        return
    raw = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
    if len(raw) > 16 * 1024 * 1024:
        raise ValueError('input limit')
    request = load_json(raw.decode())
    data = base64.b64decode(request['image'], validate=True)
    if len(data) > min(MAX_INPUT_BYTES, 8 * 1024 * 1024):
        raise ValueError('image limit')
    source = SourceEvidence('reference-1', 'screenshot', 'file:sha256:' + hashlib.sha256(data).hexdigest(), data)
    config = AnalyzerConfig.resolve({'analyzer': request['config']}, command='analyze-design')
    options = config.adapter_options('analyze-design')
    if config.agent == 'command':
        options['runner'].runner = BoundedRunner()
    else:
        options['runner'] = BoundedRunner()
    analyzer = CodexDesignAnalyzer(**options, intent=request['intent'])
    result = run_design_analyzer(analyzer, [source])
    print(json.dumps({'version': identity, 'result': json.loads(normalize_design_profile(result))}, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never expose provider diagnostics, private paths, credentials or source prose.
        print('ANALYSIS_FAILED', file=sys.stderr)
        sys.exit(1)
