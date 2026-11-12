// Runtime limits use one validated source. Optional JSON configuration is checked
// before it can affect cache matching or token accounting.
export function readLimits(env = {}) {
  const integer = (name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid ${name}: expected integer ${min}..${max}`);
    return value;
  };

  return {
    port: integer('CACHE_PORT', 4000, 0, 65535),
    upstreamPort: integer('CACHE_UPSTREAM_PORT', 443, 1, 65535),
    ttlMs: integer('CACHE_TTL_SEC', 604800, 0, Math.floor(Number.MAX_SAFE_INTEGER / 1000)) * 1000,
    maxEntries: integer('CACHE_MAX_ENTRIES', 5000),
    maxRequestBytes: integer('CACHE_MAX_REQUEST_BYTES', 32 * 1024 * 1024),
    maxResponseBytes: integer('CACHE_MAX_RESPONSE_BYTES', 32 * 1024 * 1024),
    upstreamTimeoutMs: integer('CACHE_UPSTREAM_TIMEOUT_MS', 120000, 1, 2147483647),
    maxMonitors: integer('CACHE_MAX_MONITORS', 100),
  };
}


// Pure optional-configuration validators shared by the proxy and CLI.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validatePrices(raw) {
  if (!record(raw) || !Object.entries(raw).every(([key, price]) => key.length > 0 && Array.isArray(price) && price.length === 2 && price.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0))) {
    throw new Error('invalid prices.json: expected model names mapped to two nonnegative token prices');
  }
  return raw;
}

export function validateNormalization(raw) {
  if (!record(raw)) throw new Error('invalid normalize.json: expected an object');
  const patterns = name => {
    const list = raw[name] ?? [];
    if (!Array.isArray(list) || !list.every(p => typeof p === 'string')) throw new Error(`invalid normalize.json: ${name} must be an array of strings`);
    return list;
  };
  const suffixTurns = raw.suffix_turns ?? 3;
  if (!Number.isSafeInteger(suffixTurns) || suffixTurns < 1 || (raw.suffix_only !== undefined && typeof raw.suffix_only !== 'boolean')) {
    throw new Error('invalid normalize.json: suffix_only must be boolean and suffix_turns a positive integer');
  }
  return {
    systemRe: patterns('system_strip').map(p => new RegExp(p, 'g')),
    messageRe: patterns('message_strip').map(p => new RegExp(p, 'gs')),
    suffix_only: raw.suffix_only ?? false,
    suffix_turns: suffixTurns,
  };
}
