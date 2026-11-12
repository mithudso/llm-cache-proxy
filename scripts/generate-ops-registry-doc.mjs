import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { operations } from '../lib/operations-registry.mjs';
export function extractRoutes(source) {
  // The proxy uses explicit method/path guards, including the inverse POST guard.
  return [...source.matchAll(/req\.method\s*(===|!==)\s*'(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)'\s*(?:&&|\|\|)\s*pathname\s*\1\s*'([^']+)'/g)]
    .map(match => `${match[2]} ${match[3]}`).sort();
}
function main() {
  const routes = [
    ['GET', '/health', 'Open liveness probe'], ['GET', '/stats', 'Session and all-time counters'],
    ['GET', '/metrics', 'Prometheus counters'], ['GET', '/monitor', 'Live SSE events'],
    ['POST', '/v1/messages', 'Paid miss or byte-exact replay'],
  ].map(([method, path, description]) => ({ method, path, description }));
  const actual = extractRoutes(fs.readFileSync('proxy-a.mjs', 'utf8'));
  const expected = routes.map(route => `${route.method} ${route.path}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Route inventory drift: ${JSON.stringify(actual)}; update the curated route descriptions and parser if routing syntax changes.`);
  const outputs = {
    'docs/operations-registry.json': { operations, audit: { profile: 'local-cli', centralizedErrorJsonl: false, dashboardCards: false, genericOperationRunner: false, note: 'Inventory only. Existing CLI, logs and monitoring are used; this does not claim the mdb-tam five-standard contract.' } },
    'docs/tool-inventory.json': { totalRoutes: routes.length, routes, mcpTools: [] },
  };
  for (const [file, value] of Object.entries(outputs)) {
    const expected = JSON.stringify(value, null, 2) + '\n';
    if (process.argv.includes('--check')) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== expected) throw new Error(`${file} is stale; run npm run ops:doc`);
    } else fs.writeFileSync(file, expected);
  }
  console.log('Operations inventory is current.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
