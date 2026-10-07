#!/usr/bin/env node
// Structured data only: network commands and process time limits live in Bash.
import { constants, openSync, closeSync, fstatSync, readSync, readFileSync,
  statSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, visit, isScalar } from 'yaml';

const MAX_BYTES = 1024 * 1024;
const control = /[\x00-\x1f\x7f-\x9f]/u;
const own = (object, key) => Object.hasOwn(object, key);
const valueOr = (object, key, fallback) => own(object, key) ? object[key] : fallback;
const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export class ConfigError extends Error {}
function requireValue(condition, message) {
  if (!condition) throw new ConfigError(message);
}

function fields(value, allowed, path) {
  requireValue(mapping(value), `${path} must be a mapping`);
  requireValue(Object.keys(value).every(key => allowed.includes(key)), `${path} contains an unknown field`);
}

function text(value, path, maximum = 4096) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !control.test(value),
    `${path} must be a nonempty printable string (max ${maximum} characters)`);
  return value;
}

function expand(value, path, env) {
  requireValue(typeof value === 'string', `${path} must be a string`);
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    requireValue(own(env, key) && env[key] !== undefined, `${path}: environment variable ${key} is not set`);
    return env[key];
  });
}

export function duration(value, path = 'timeout') {
  const match = typeof value === 'string' && /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
  requireValue(match, `${path} must be a duration such as 500ms, 5s, 2m or 1h`);
  const number = Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]];
  requireValue(Number.isFinite(number) && number >= 1 && number <= 86400000, `${path} must be between 1ms and 24h`);
  return Math.ceil(number);
}

function integer(value, minimum, maximum, path) {
  requireValue(Number.isInteger(value) && value >= minimum && value <= maximum,
    `${path} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

function hostname(value, path, env) {
  value = text(expand(value, path, env), path, 253);
  requireValue(isIP(value) || /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(value),
    `${path} must be a hostname or an unbracketed IP address`);
  return value;
}

export function loadConfig(path, env = process.env) {
  // Opening with O_NONBLOCK also lets us reject FIFOs before attempting a read.
  const file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    requireValue(fstatSync(file).isFile(), 'config must be a regular file');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(file, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    requireValue(size <= MAX_BYTES, 'config exceeds 1 MiB');
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)); }
    catch { throw new ConfigError('config must contain valid UTF-8'); }
    return parseConfig(source, env);
  } finally { closeSync(file); }
}

export function parseConfig(source, env = process.env) {
  requireValue(Buffer.byteLength(source) <= MAX_BYTES, 'config exceeds 1 MiB');
  let data;
  try {
    const document = parseDocument(source, { strict: true, uniqueKeys: true, version: '1.2' });
    if (document.errors.length || document.warnings.length) throw new Error('Invalid YAML');
    visit(document, {
      Alias() { throw new Error('Aliases are not supported'); },
      Pair(_key, pair) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('Keys must be strings');
      },
    });
    data = document.toJS({ maxAliasCount: 0 });
  } catch {
    // Parser errors may include credentials copied from the source text.
    throw new ConfigError('invalid YAML: use one document, unique string keys, and no aliases or custom tags');
  }
  fields(data, ['service', 'global', 'checks'], 'config');
  fields(data.service, ['name', 'environment'], 'service');
  const service = Object.fromEntries(Object.entries(data.service).map(([key, value]) =>
    [key, text(expand(value, `service.${key}`, env), `service.${key}`, 256)]));
  requireValue(own(service, 'name'), 'service.name is required');
  const global = valueOr(data, 'global', {});
  fields(global, ['timeout'], 'global');
  const timeout = duration(valueOr(global, 'timeout', '30s'), 'global.timeout');
  requireValue(Array.isArray(data.checks) && data.checks.length >= 1 && data.checks.length <= 1024,
    'checks must contain 1 to 1024 entries');
  const names = new Set();
  const typeFields = {
    dns: ['host', 'record', 'server'], tcp: ['host', 'port'],
    http: ['url', 'expected_status', 'method', 'headers'],
    tls: ['host', 'port', 'server_name', 'ca_file'], ping: ['host'], service: ['unit'],
  };
  const checks = data.checks.map((check, index) => {
    const path = `checks[${index}]`;
    requireValue(mapping(check), `${path} must be a mapping`);
    const kind = check.type;
    requireValue(typeof kind === 'string' && own(typeFields, kind), `${path}.type must be dns, tcp, http, tls, ping or service`);
    fields(check, ['name', 'type', 'required', 'timeout', ...typeFields[kind]], path);
    const name = text(check.name, `${path}.name`, 256);
    requireValue(!names.has(name), `${path}.name must be unique`);
    names.add(name);
    const required = valueOr(check, 'required', true);
    requireValue(typeof required === 'boolean', `${path}.required must be a boolean`);
    const out = { name, type: kind, required, timeout_ms: duration(valueOr(check, 'timeout', '5s'), `${path}.timeout`) };
    if (['dns', 'tcp', 'tls', 'ping'].includes(kind)) {
      out.host = hostname(check.host, `${path}.host`, env);
      out.target = out.host;
    }
    if (['tcp', 'tls'].includes(kind)) {
      let port = valueOr(check, 'port', kind === 'tls' ? 443 : undefined);
      if (typeof port === 'string') {
        requireValue(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(port), `${path}.port must be an integer or environment variable`);
        port = expand(port, `${path}.port`, env);
        requireValue(/^[0-9]+$/.test(port), `${path}.port must be an integer between 1 and 65535`);
        port = Number(port);
      }
      out.port = integer(port, 1, 65535, `${path}.port`);
      out.target = `${out.host.includes(':') ? `[${out.host}]` : out.host}:${out.port}`;
    }
    if (kind === 'dns') {
      out.record = valueOr(check, 'record', 'A');
      requireValue(['A', 'AAAA'].includes(out.record), `${path}.record must be A or AAAA`);
      if (own(check, 'server')) out.server = hostname(check.server, `${path}.server`, env);
    }
    if (kind === 'tls') {
      out.server_name = hostname(valueOr(check, 'server_name', out.host), `${path}.server_name`, env);
      if (own(check, 'ca_file')) {
        out.ca_file = text(expand(check.ca_file, `${path}.ca_file`, env), `${path}.ca_file`);
        let exists = false;
        try { exists = statSync(out.ca_file).isFile(); } catch { /* Invalid path, without exposing its value. */ }
        requireValue(exists, `${path}.ca_file does not exist`);
      }
    }
    if (kind === 'service') {
      const unit = text(check.unit, `${path}.unit`, 256);
      requireValue(/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(unit), `${path}.unit is invalid`);
      out.unit = out.target = unit;
    }
    if (kind === 'http') {
      const url = text(expand(check.url, `${path}.url`, env), `${path}.url`, 8192);
      let parsed;
      try { parsed = new URL(url); }
      catch { throw new ConfigError(`${path}.url is invalid`); }
      requireValue(/^https?:\/\//i.test(url) && ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname &&
        !parsed.username && !parsed.password && !parsed.hash && !/\s|\\/u.test(url) && parsed.port !== '0',
      `${path}.url must be HTTP(S), without userinfo, fragment or whitespace`);
      out.url = url;
      // Preserve the configured spelling/path for compatibility; omit query secrets.
      out.target = url.split(/[?#]/u, 1)[0];
      out.expected_status = integer(valueOr(check, 'expected_status', 200), 100, 599, `${path}.expected_status`);
      out.method = valueOr(check, 'method', 'GET');
      requireValue(['GET', 'HEAD'].includes(out.method), `${path}.method must be GET or HEAD`);
      const headers = valueOr(check, 'headers', {});
      requireValue(mapping(headers), `${path}.headers must be a mapping`);
      out.headers = Object.create(null);
      for (const [key, value] of Object.entries(headers)) {
        requireValue(/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/.test(key), `${path}.headers contains an invalid name`);
        const lower = key.toLowerCase();
        requireValue(!own(out.headers, lower) && !['connection', 'content-length', 'transfer-encoding', 'upgrade'].includes(lower),
          `${path}.headers contains a duplicate or reserved name`);
        out.headers[lower] = text(expand(value, `${path}.headers`, env), `${path}.headers`);
      }
    }
    return out;
  });
  return { service, timeout_ms: timeout, checks };
}

function createDirectory(path) {
  // Avoid recursive mkdir's repeated ENOENT retries on virtual filesystems such
  // as /proc. Try each parent once, then let the final mkdir fail normally.
  try { mkdirSync(path); }
  catch (error) {
    if (error.code === 'EEXIST' && statSync(path).isDirectory()) return;
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(resolve(path));
    if (parent === resolve(path)) throw error;
    createDirectory(parent);
    mkdirSync(path);
  }
}

export function atomicWrite(path, content) {
  const parent = dirname(path);
  createDirectory(parent);
  const temporary = join(parent, `.diagnostic-${randomUUID()}`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function report(config, rows, started, elapsed, interrupted, version) {
  const count = predicate => rows.filter(predicate).length;
  const summary = {
    total: rows.length, passed: count(r => r.status === 'passed'), failed: count(r => r.status === 'failed'),
    errors: count(r => r.status === 'error'), required_failed: count(r => r.required && r.status === 'failed'),
    optional_failed: count(r => !r.required && r.status === 'failed'),
  };
  const code = interrupted || summary.errors ? 2 : summary.required_failed ? 1 : 0;
  return { schema_version: 1, tool_version: version, service: config.service,
    started_at: started, duration_ms: elapsed, interrupted,
    timed_out: rows.some(r => r.error_code === 'GLOBAL_TIMEOUT'),
    status: ['passed', 'failed', 'error'][code], exit_code: code, summary, checks: rows };
}

export function human(data) {
  const lines = ['='.repeat(56), ' POST DEPLOYMENT DIAGNOSTIC', '='.repeat(56), `Service: ${data.service.name}`];
  if (data.service.environment) lines.push(`Environment: ${data.service.environment}`);
  lines.push('');
  for (const row of data.checks) {
    const mark = row.status === 'passed' ? '✓' : '✗';
    const optional = row.required ? '' : ' [optional]';
    lines.push(`${mark} ${row.type.toUpperCase().padEnd(7)} ${row.name}: ${row.target} (${row.duration_ms}ms)${optional}`);
    if (row.detail) lines.push(`  ${row.detail}`);
    if (row.error) lines.push(`  Error: ${row.error}`);
    for (const hint of row.hints ?? []) lines.push(`  Possible cause / next check: ${hint}`);
  }
  const s = data.summary;
  lines.push('', `Checks: ${s.total} | Passed: ${s.passed} | Failed: ${s.failed} | Tool errors: ${s.errors}`,
    `DIAGNOSTIC: ${['SUCCESS', 'FAILED', 'TOOL ERROR'][data.exit_code]}`, '='.repeat(56));
  return `${lines.join('\n')}\n`;
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

export function junit(data) {
  const s = data.summary;
  const lines = ['<?xml version="1.0" encoding="utf-8"?>',
    `<testsuite name="${xml(data.service.name)}" tests="${s.total}" failures="${s.required_failed}" errors="${s.errors}" skipped="${s.optional_failed}" time="${data.duration_ms / 1000}">`];
  for (const row of data.checks) {
    lines.push(`  <testcase name="${xml(row.name)}" classname="diagnostic.${xml(row.type)}" time="${row.duration_ms / 1000}">`);
    if (row.status !== 'passed') {
      const tag = row.status === 'error' ? 'error' : row.required ? 'failure' : 'skipped';
      lines.push(`    <${tag} message="${xml(row.error ?? 'Check failed')}">${xml(row.error_code ?? '')}</${tag}>`);
    }
    lines.push(`    <system-out>${xml(`Target: ${row.target}\n${row.detail ?? ''}`)}</system-out>`, '  </testcase>');
  }
  return `${lines.join('\n')}\n</testsuite>\n`;
}

export function curlConfig(check) {
  const quote = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [`url = ${quote(check.url)}`, ...Object.entries(check.headers).map(([key, value]) => `header = ${quote(`${key}: ${value}`)}`)].join('\n') + '\n';
}

function main([action, ...args]) {
  if (action === 'config') {
    process.stdout.write(JSON.stringify(loadConfig(args[0])) + '\n');
  } else if (action === 'duration') {
    process.stdout.write(String(duration(args[0], '--timeout')) + '\n');
  } else if (action === 'curl-config') {
    const check = JSON.parse(readFileSync(args[0], 'utf8')).checks[Number(args[1])];
    writeFileSync(args[2], curlConfig(check), { mode: 0o600 });
  } else if (action === 'report') {
    const [configPath, rowsPath, started, elapsed, interrupted, version, output, jsonPath, junitPath] = args;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const rows = readFileSync(rowsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const data = report(config, rows, started, Number(elapsed), interrupted === '1', version);
    const encoded = JSON.stringify(data, null, 2) + '\n';
    if (jsonPath) atomicWrite(jsonPath, encoded);
    if (junitPath) atomicWrite(junitPath, junit(data));
    process.stdout.write(output === 'json' ? encoded : human(data));
    return data.exit_code;
  } else {
    throw new ConfigError('unknown data action');
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    const message = error instanceof ConfigError ? `Configuration error: ${error.message}` :
      'Tool error: unable to read configuration or write report; check paths and permissions';
    process.stderr.write(message + '\n');
    process.exitCode = 2;
  }
}
