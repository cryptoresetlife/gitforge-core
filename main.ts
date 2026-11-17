// gitforge: a GitHub-compatible forge in one process. This file is the trial lifecycle: bind an
// ephemeral port, tell the env which one, serve until the env says the trial is over, exit 0.
// The server itself (git smart HTTP, REST v3, GraphQL v4 and MCP over one in-memory store) lives in
// src/. The file is plain JavaScript on purpose, so Node runs it without any type stripping work.

import { createApp } from './src/server.mjs';

const ENV_URL = (process.env.MAKEFUN_ENV_URL || '').replace(/\/+$/, '');
const FIXED_PORT = Number(process.env.FORGE_PORT || 0);

// How often to ask the env whether the trial is over. The answer only matters once, at the end.
const DONE_POLL_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server.address().port));
  });
}

// POST the bound port until the env takes it. 409 means a register already won: keep serving.
async function register(port) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(15000),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered')) throw err;
    }
    await sleep(Math.min(1000, 50 * 2 ** Math.min(attempt, 5)));
  }
}

// Poll GET /done until it says {"done": true}. The suite is busy talking to this process while it
// waits, so the poll is deliberately slow: it should cost the timed workloads nothing.
async function waitForDone() {
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const body = await res.json();
        if (body && body.done === true) return;
      } else {
        await res.arrayBuffer().catch(() => undefined);
      }
    } catch {
      // not answering yet, or a slow poll: it is not done
    }
    await sleep(DONE_POLL_MS);
  }
}

async function main() {
  const server = createApp();
  const port = await listen(server, FIXED_PORT);
  process.stdout.write(`[gitforge] listening on port ${port}\n`);
  if (ENV_URL === '') {
    if (FIXED_PORT > 0) return new Promise(() => undefined);
    throw new Error('MAKEFUN_ENV_URL is not set: there is no env to register with');
  }
  await register(port);
  process.stdout.write('[gitforge] registered\n');
  await waitForDone();
  server.close();
  process.stdout.write('[gitforge] done\n');
  return undefined;
}

process.on('uncaughtException', (err) => {
  process.stderr.write(`[gitforge] uncaught: ${err && err.stack ? err.stack : String(err)}\n`);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[gitforge] unhandled: ${err && err.stack ? err.stack : String(err)}\n`);
});

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[gitforge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
