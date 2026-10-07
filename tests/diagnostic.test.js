import assert from 'node:assert/strict';
import { before, after, beforeEach, afterEach, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { createServer as createTCPServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, parseAllDocuments, stringify } from 'yaml';
import { ConfigError, loadConfig, parseConfig, duration, report, junit } from '../lib/data.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(ROOT, 'bin/diagnostic');
const base = () => ({ service: { name: 'api' }, checks: [{ name: 'tcp', type: 'tcp', host: 'localhost', port: 80 }] });
const read = path => readFileSync(path, 'utf8');

describe('Configuration', () => {
  it('provides the existing defaults', () => {
    const cfg = parseConfig('service: {name: api}\nchecks: [{name: app, type: http, url: "http://localhost/health"}]');
    assert.equal(cfg.timeout_ms, 30000);
    assert.equal(cfg.checks[0].required, true);
    assert.equal(cfg.checks[0].expected_status, 200);
  });

  it('rejects malformed YAML and invalid fields/types', () => {
    const cases = ['', 'service: [api]', 'service: {name: api}\nchecks: []',
      'service: {name: api, typo: true}\nchecks: []',
      'service: {name: api, name: api}\nchecks: []',
      'service: &a {name: api}\nchecks: [*a]',
      'service: {name: api}\nchecks: []\n---\n{}',
      'service: {name: api}\nchecks: []\n123: invalid',
      'service: {name: !!custom secret}\nchecks: []'];
    for (const [key, value] of [['port', 0], ['port', 65536], ['port', true], ['required', 'true'],
      ['timeout', '-1s'], ['timeout', '0s'], ['type', 'shell'], ['host', '-x'], ['url', 'http://localhost'], ['typo', true]]) {
      const config = base();
      config.checks[0][key] = value;
      cases.push(stringify(config));
    }
    for (const source of cases) assert.throws(() => parseConfig(source), ConfigError, source);
  });

  it('does not replace explicit null with defaults', () => {
    for (const field of ['required', 'timeout', 'host', 'port']) {
      const config = base();
      config.checks[0][field] = null;
      assert.throws(() => parseConfig(stringify(config)), ConfigError, field);
    }
  });

  it('expands values without YAML injection or recursive expansion', () => {
    const secret = 'Bearer "secret": ${NOT_REEXPANDED}';
    const cfg = parseConfig('service: {name: api}\nchecks:\n- name: h\n  type: http\n  url: http://localhost\n  headers: {Authorization: "${DIAG_TEST_TOKEN}"}', { DIAG_TEST_TOKEN: secret });
    assert.equal(cfg.checks[0].headers.authorization, secret);
  });

  it('rejects missing environment variables', () => {
    assert.throws(() => parseConfig('service: {name: api}\nchecks: [{name: t, type: tcp, host: "${MISSING}", port: 80}]', {}), ConfigError);
  });

  it('validates environment-provided TCP ports without exposing their values in errors', () => {
    const source = 'service: {name: api}\nchecks: [{name: sentinel, type: tcp, host: "${SENTINEL_HOST}", port: "${SENTINEL_PORT}"}]';
    const config = parseConfig(source, { SENTINEL_HOST: 'sentinel.internal', SENTINEL_PORT: '26379' });
    assert.equal(config.checks[0].target, 'sentinel.internal:26379');
    assert.equal(parseConfig(source.replace('type: tcp', 'type: tls'),
      { SENTINEL_HOST: 'sentinel.internal', SENTINEL_PORT: '26379' }).checks[0].port, 26379);
    for (const port of ['0', '65536', '26379; echo secret', '']) {
      assert.throws(() => parseConfig(source, { SENTINEL_HOST: 'sentinel.internal', SENTINEL_PORT: port }),
        error => error instanceof ConfigError && !error.message.includes('echo secret'));
    }
    assert.throws(() => parseConfig(source, { SENTINEL_HOST: 'sentinel.internal' }), ConfigError);
  });

  it('validates HTTP URLs', () => {
    for (const url of ['ftp://localhost', 'http://u:p@localhost', 'http://localhost:0', 'http://localhost:99999', 'http://localhost/a#secret', 'http://localhost/a\nb']) {
      assert.throws(() => parseConfig(stringify({ service: { name: 'api' }, checks: [{ name: 'x', type: 'http', url }] })), ConfigError, url);
    }
  });

  it('bounds and parses durations', () => {
    assert.equal(duration('1.5s'), 1500);
    for (const value of ['0s', '25h', '1', 1, null]) assert.throws(() => duration(value), ConfigError);
  });

  it('rejects nonregular files without blocking', () => {
    const directory = mkdtempSync(join(tmpdir(), 'diagnostic-fifo-'));
    try {
      const fifo = join(directory, 'config.fifo');
      execFileSync('mkfifo', [fifo]);
      assert.throws(() => loadConfig(fifo), ConfigError);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects oversized and invalid UTF-8 files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'diagnostic-size-'));
    try {
      const file = join(directory, 'config.yml');
      for (const bytes of [Buffer.alloc(1024 * 1024 + 1, 32), Buffer.from([0xff])]) {
        writeFileSync(file, bytes);
        assert.throws(() => loadConfig(file), ConfigError);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

function runCLI(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [CLI, ...args], { env, detached: true });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      // The CLI and its report helper share this process group. Killing only
      // Bash could leave an unresponsive helper holding the output pipes open.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Child already exited. */ }
    }, 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('CLI did not exit within 20 seconds'));
      else resolve({ code, stdout, stderr });
    });
  });
}

function xmlValue(path, expression) {
  return execFileSync('xmllint', ['--nonet', '--xpath', expression, path], { encoding: 'utf8' }).trim();
}

describe('Linux network integration', { skip: process.platform !== 'linux' }, () => {
  let http, https, dns, cert, certificateDirectory, directory;
  const handler = (request, response) => {
    const respond = () => {
      let code = request.url.startsWith('/fail') ? 500 : request.url.startsWith('/redirect') ? 302 : 200;
      if (request.url.startsWith('/auth') && request.headers.authorization !== 'Bearer secret-value') code = 401;
      response.writeHead(code, { Location: '/ok' });
      response.end();
    };
    if (request.url.startsWith('/slow')) {
      const timer = setTimeout(respond, 3000);
      response.once('close', () => clearTimeout(timer));
    } else respond();
  };

  before(async () => {
    http = createServer(handler);
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    dns = createSocket('udp4');
    dns.on('message', (packet, remote) => {
      let position = 12;
      while (packet[position]) position += packet[position] + 1;
      position++;
      const query = packet.subarray(12, position + 4);
      const success = query.includes(Buffer.from('diag')) && packet.readUInt16BE(position) === 1;
      const header = Buffer.alloc(12);
      packet.copy(header, 0, 0, 2);
      header.writeUInt16BE(success ? 0x8180 : 0x8183, 2);
      header.writeUInt16BE(1, 4);
      header.writeUInt16BE(success ? 1 : 0, 6);
      const answer = success ? Buffer.from('c00c000100010000003c00047f000001', 'hex') : Buffer.alloc(0);
      dns.send(Buffer.concat([header, query, answer]), remote.port, remote.address);
    });
    dns.bind(53, '127.0.0.1');
    await once(dns, 'listening');
    certificateDirectory = mkdtempSync(join(tmpdir(), 'diagnostic-tls-'));
    cert = join(certificateDirectory, 'cert.pem');
    const key = join(certificateDirectory, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
    https = createSecureServer({ key: read(key), cert: read(cert) }, handler);
    https.listen(0, '127.0.0.1');
    await once(https, 'listening');
  });

  after(async () => {
    for (const server of [http, https]) {
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }
    if (dns) await new Promise(resolve => dns.close(resolve));
    if (certificateDirectory) rmSync(certificateDirectory, { recursive: true, force: true });
  });
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'diagnostic-test-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  const httpCheck = (path = '/ok', options = {}) => ({ name: 'http', type: 'http', url: `http://127.0.0.1:${http.address().port}${path}`, ...options });
  function config(checks, timeout = '15s') {
    const file = join(directory, 'diagnostic.yml');
    writeFileSync(file, stringify({ service: { name: 'test<&>"\'' }, global: { timeout }, checks }));
    return file;
  }
  async function cli(checks, { timeout, extra = [], env } = {}) {
    const result = await runCLI(['run', '--config', config(checks, timeout), '--format', 'json', ...extra], env);
    return { ...result, report: result.stdout ? JSON.parse(result.stdout) : undefined };
  }

  it('passes DNS, TCP and HTTP', async () => {
    const result = await cli([{ name: 'dns', type: 'dns', host: 'diag.test', server: '127.0.0.1' },
      { name: 'tcp', type: 'tcp', host: '127.0.0.1', port: http.address().port }, httpCheck()]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.report.summary.passed, 3);
  });

  it('detects a missing DNS record', async () => {
    const result = await cli([{ name: 'dns', type: 'dns', host: 'missing.test', server: '127.0.0.1' }]);
    assert.equal(result.code, 1);
    assert.equal(result.report.checks[0].error_code, 'DNS_ERROR');
  });

  it('detects TCP connection refusal', async () => {
    const server = createTCPServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const result = await cli([{ name: 'tcp', type: 'tcp', host: '127.0.0.1', port }]);
    assert.equal(result.code, 1);
    assert.equal(result.report.checks[0].error_code, 'CONNECTION_REFUSED');
  });

  it('fails on unexpected HTTP status and does not follow redirects', async () => {
    for (const path of ['/fail', '/redirect']) {
      const result = await cli([httpCheck(path)]);
      assert.equal(result.code, 1);
      assert.equal(result.report.checks[0].error_code, 'HTTP_STATUS');
    }
  });

  it('supports HEAD and explicit expected status', async () => {
    assert.equal((await cli([httpCheck('/fail', { method: 'HEAD', expected_status: 500 })])).code, 0);
  });

  it('treats URL brackets literally', async () => {
    assert.equal((await cli([httpCheck('/ok?ids=[1,2]')])).code, 0);
  });

  it('keeps optional failures nonblocking in JSON and valid JUnit', async () => {
    const xml = join(directory, 'reports/result.xml'), json = join(directory, 'reports/result.json');
    const result = await cli([httpCheck('/fail', { required: false })], { extra: ['--junit-report', xml, '--json-report', json] });
    assert.equal(result.code, 0);
    assert.equal(result.report.summary.optional_failed, 1);
    assert.equal(xmlValue(xml, 'string(/testsuite/@failures)'), '0');
    assert.equal(xmlValue(xml, 'string(/testsuite/@skipped)'), '1');
    assert.equal(xmlValue(xml, 'string(/testsuite/@name)'), 'test<&>"\'');
    assert.deepEqual(JSON.parse(read(json)), result.report);
  });

  it('marks required failures in JUnit', async () => {
    const xml = join(directory, 'failure.xml');
    const result = await cli([httpCheck('/fail')], { extra: ['--junit-report', xml] });
    assert.equal(result.code, 1);
    assert.equal(xmlValue(xml, 'string(/testsuite/@failures)'), '1');
  });

  it('bounds each check with a timeout', async () => {
    const result = await cli([httpCheck('/slow', { timeout: '500ms' })]);
    assert.equal(result.code, 1);
    assert.equal(result.report.checks[0].error_code, 'CHECK_TIMEOUT');
    assert.ok(result.report.duration_ms < 2500);
  });

  it('retains pending results when the global budget expires', async () => {
    const result = await cli([httpCheck('/slow'), { name: 'later', type: 'tcp', host: '127.0.0.1', port: http.address().port }], { timeout: '500ms' });
    assert.equal(result.code, 1);
    assert.equal(result.report.timed_out, true);
    assert.equal(result.report.checks.length, 2);
    assert.ok(result.report.checks.every(row => row.error_code === 'GLOBAL_TIMEOUT'));
  });

  it('supports the timeout override', async () => {
    const result = await cli([httpCheck('/slow')], { extra: ['--timeout', '500ms'] });
    assert.equal(result.code, 1);
    assert.equal(result.report.timed_out, true);
    assert.equal((await cli([httpCheck()], { extra: ['--timeout', 'invalid'] })).code, 2);
  });

  it('sends headers but redacts header and query secrets from reports', async () => {
    const result = await cli([httpCheck('/auth?token=query-secret', { headers: { Authorization: 'Bearer ${DIAG_TEST_SECRET}' } })],
      { env: { ...process.env, DIAG_TEST_SECRET: 'secret-value' } });
    assert.equal(result.code, 0);
    assert.ok(!/secret-value|query-secret/.test(result.stdout + result.stderr));
  });

  it('verifies TLS trust and hostname', async () => {
    const check = { name: 'tls', type: 'tls', host: '127.0.0.1', port: https.address().port, server_name: 'localhost', ca_file: cert };
    const trusted = await cli([check]);
    assert.equal(trusted.code, 0, trusted.stdout + trusted.stderr);
    const mismatch = await cli([{ ...check, server_name: 'wrong.test' }]);
    assert.equal(mismatch.code, 1);
    assert.equal(mismatch.report.checks[0].error_code, 'TLS_ERROR');
  });

  it('rejects untrusted HTTPS certificates', async () => {
    const result = await cli([{ name: 'tls', type: 'http', url: `https://localhost:${https.address().port}/ok` }]);
    assert.equal(result.code, 1);
    assert.equal(result.report.checks[0].error_code, 'TLS_ERROR');
  });

  it('returns 2 for an invalid configuration', async () => {
    assert.equal((await cli([httpCheck('/ok', { required: 'false' })])).code, 2);
  });

  it('returns 2 for an unwritable report destination', async () => {
    assert.equal((await cli([httpCheck()], { extra: ['--json-report', '/proc/diagnostic-test/report.json'] })).code, 2);
  });

  it('refuses to overwrite the configuration', async () => {
    const result = await cli([httpCheck()], { extra: ['--json-report', join(directory, 'diagnostic.yml')] });
    assert.equal(result.code, 2);
    assert.match(read(join(directory, 'diagnostic.yml')), /service:/);
  });

  it('reports SIGTERM as an interruption with exit 2', async () => {
    const child = spawn('bash', [CLI, 'run', '--config', config([httpCheck('/slow')]), '--format', 'json']);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = once(child, 'close');
    const guard = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await delay(600);
      child.kill('SIGTERM');
      const [code] = await closed;
      assert.equal(code, 2, stdout + stderr);
      assert.equal(JSON.parse(stdout).interrupted, true);
    } finally { clearTimeout(guard); }
  });

  it('supports validation, help, version and the human report', async () => {
    const path = config([httpCheck()]);
    for (const args of [['validate', '--config', path], ['--help'], ['version']]) {
      assert.equal((await runCLI(args)).code, 0);
    }
    const result = await runCLI(['run', '--config', path]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /DIAGNOSTIC: SUCCESS/);
  });

  it('escapes JUnit attributes and represents tooling errors separately', () => {
    const rows = [{ name: 'name<&>"\'', type: 'tcp', target: 'host:80', required: false, duration_ms: 1,
      status: 'error', error: 'tool <error> & "details"', error_code: 'TOOL_ERROR' }];
    const data = report({ service: { name: 'test' } }, rows, '2026-09-30T00:00:00Z', 1, false, 'test');
    const file = join(directory, 'error.xml');
    writeFileSync(file, junit(data));
    assert.equal(data.exit_code, 2);
    assert.equal(xmlValue(file, 'string(/testsuite/@errors)'), '1');
    assert.equal(xmlValue(file, 'string(/testsuite/testcase/@name)'), rows[0].name);
    assert.equal(xmlValue(file, 'string(/testsuite/testcase/error/@message)'), rows[0].error);
  });
});

describe('GitLab templates', () => {
  it('retains the reusable job and component contract', () => {
    const template = parse(read(join(ROOT, 'templates/diagnostic.yml')))['.post-deploy-diagnostic'];
    const [spec, body] = parseAllDocuments(read(join(ROOT, 'templates/post-deploy.yml'))).map(doc => doc.toJS());
    assert.equal(spec.spec.inputs.needs.type, 'array');
    for (const job of [template, Object.values(body)[0]]) {
      assert.deepEqual(job.image.entrypoint, ['']);
      assert.equal(job.artifacts.when, 'always');
      assert.equal(job.allow_failure, false);
      assert.ok(job.script.every(command => typeof command === 'string'));
    }
  });

  it('uses the Node.js test environment in the project pipeline', () => {
    const pipeline = parse(read(join(ROOT, '.gitlab-ci.yml')));
    assert.match(pipeline.test.image, /^node:24/);
    assert.ok(pipeline.publish_image);
  });
});
