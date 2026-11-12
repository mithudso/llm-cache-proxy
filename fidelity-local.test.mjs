// Exercise the paid-test entrypoint against an authenticated local fixture only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { boot } from './test-helpers.mjs';

test('fidelity entrypoint supports authenticated proxies without paid calls', { timeout: 10000 }, async () => {
  const p = await boot({ env: { CACHE_AUTH_TOKEN: 'synthetic-fidelity-token' }, responder(req, res, raw, state) {
    state.count++;
    const body = JSON.parse(raw);
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.end('event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"type":"tool_use","delta":"input_json_delta"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use' }], usage: { input_tokens: 4, output_tokens: 2 } }));
    }
  } });
  try {
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./test-fidelity.mjs', import.meta.url))], { env: { ...process.env, CACHE_PORT: String(p.port) }, timeout: 8000 });
    assert.match(result.stdout, /ALL PASS : 23 passed, 0 failed/);
    assert.equal(p.state.count, 4);
  } finally { await p.close(); }
});
