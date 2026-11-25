// Starts server.js on a free port and resolves once it is listening.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CWD = fileURLToPath(new URL('..', import.meta.url));

export function spawnServer(env) {
  return spawn(process.execPath, ['server.js'], {
    cwd: CWD,
    env: {
      ...process.env, PORT: '0', HOST: '127.0.0.1', MOCK_EXTRACTION: '1', ANTHROPIC_API_KEY: '', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function startServer(env, timeoutMs = 20000) {
  const proc = spawnServer(env);
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`server did not start in ${timeoutMs} ms\n${out}`)), timeoutMs);
    function fail(err) {
      clearTimeout(timer);
      proc.kill();
      reject(err);
    }
    const onData = (d) => {
      out += d;
      const m = /http:\/\/localhost:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, base: `http://127.0.0.1:${m[1]}` });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('exit', (code) => fail(new Error(`server exited with code ${code}\n${out}`)));
  });
}
