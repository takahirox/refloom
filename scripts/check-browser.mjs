import { captureDiagnosticCode, verifyChromeRuntime } from '../src/chrome-capture.js';

try {
  await verifyChromeRuntime();
  console.log('Refloom browser runtime check passed.');
} catch (error) {
  console.error(`Refloom browser runtime check failed: ${captureDiagnosticCode(error) || 'CAPTURE_RUNTIME_FAILED'}`);
  process.exitCode = 1;
}
