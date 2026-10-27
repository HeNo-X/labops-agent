/** Real local Nginx; fictional Native/Agent data and a controlled streaming upstream. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createReviewFixture} from '../scripts/create-review-fixture.mjs';

const agentRoot = fileURLToPath(new URL('..', import.meta.url));
const root = path.dirname(agentRoot);
const nginx = process.env.LABOPS_NGINX_PATH || 'nginx';
const output = path.resolve(process.env.LABOPS_QA_OUTPUT || path.join(agentRoot, '.review-shots-nginx'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-nginx-'));
const children = new Set();
const results = [];
const tlsAgent = new https.Agent({keepAlive: true, maxSockets: 256, rejectUnauthorized: false});
const serverTemplate = fs.readFileSync(path.join(agentRoot, 'deploy/nginx-labops.conf'), 'utf8');
const proxyTemplate = fs.readFileSync(path.join(agentRoot, 'deploy/labops-proxy.conf'), 'utf8');
const originMap = fs.readFileSync(path.join(root, 'deploy/nginx/qz-client-origins.conf'), 'utf8');
const errorHeaders = path.join(root, 'deploy/nginx/qz-error-headers.conf');
const errorTemplate = fs.readFileSync(path.join(root, 'deploy/nginx/qz-api-errors.conf'), 'utf8').replaceAll('/etc/nginx/snippets/qz-error-headers.conf', errorHeaders);
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let logs = '', nginxProcess, probeServer, proxyPort, nativeBase, nginxVersion;
fs.mkdirSync(output, {recursive: true});

async function port() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

function launch(command, args, env = {}) {
  const child = spawn(command, args, {env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
  children.add(child);
  child.stdout.on('data', data => { logs += data.toString(); });
  child.stderr.on('data', data => { logs += data.toString(); });
  child.on('error', error => { logs += error.message; });
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise(resolve => child.once('exit', resolve));
  child.kill(child === nginxProcess ? 'SIGQUIT' : 'SIGTERM');
  await Promise.race([done, wait(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await done;
  }
  children.delete(child);
}

async function ready(base, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, '隔离服务提前退出');
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await wait(50);
  }
  throw new Error('隔离服务启动超时');
}

function request(urlPath, {method = 'GET', headers = {}, data, onChunk} = {}) {
  const body = data === undefined ? undefined : Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = https.request({hostname: '127.0.0.1', port: proxyPort, path: urlPath, method,
      agent: tlsAgent, rejectUnauthorized: false,
      headers: {...(body ? {'Content-Type': 'application/json', 'Content-Length': body.length} : {}), ...headers}}, res => {
      const chunks = [], arrivals = [];
      res.on('data', chunk => {
        chunks.push(chunk); arrivals.push(Math.round(performance.now() - started));
        onChunk?.(chunk, req, res);
      });
      res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        let json;
        try {
          if (body && res.headers['content-type']?.includes('application/json')) json = JSON.parse(body);
        } catch (error) { reject(error); return; }
        resolve({status: res.statusCode, headers: res.headers, body, json, arrivals,
          durationMs: Math.round(performance.now() - started)});
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('本地代理请求超时')));
    req.end(body);
  });
}

function events(body) {
  return body.split('\n\n').filter(block => block.startsWith('event: '))
    .map(block => JSON.parse(block.split('\n').find(line => line.startsWith('data: ')).slice(6)));
}

async function record(name, fn) {
  console.log('RUN ' + name);
  const detail = await fn();
  results.push({name, pass: true, ...(detail ? {detail} : {})});
  console.log('PASS ' + name);
}

async function startProxy(upstreamPort) {
  await stop(nginxProcess);
  const proxyFile = path.join(temp, 'labops-proxy.conf');
  const errorFile = path.join(temp, 'qz-api-errors.conf');
  fs.writeFileSync(errorFile, errorTemplate);
  fs.writeFileSync(proxyFile, proxyTemplate.replace('http://127.0.0.1:8787', 'http://127.0.0.1:' + upstreamPort));
  const server = serverTemplate
    .replace('listen 8788 ssl http2;', `listen 127.0.0.1:${proxyPort} ssl http2;`)
    .replaceAll('/etc/nginx/snippets/labops-proxy.conf', proxyFile)
    .replaceAll('/etc/nginx/snippets/qz-api-errors.conf', errorFile)
    .replace('/etc/nginx/ssl/lab/fullchain.pem', path.join(temp, 'certificate.pem'))
    .replace('/etc/nginx/ssl/lab/privkey.pem', path.join(temp, 'private.key'));
  const configFile = path.join(temp, 'nginx.conf');
  const localUser = process.getuid?.() === 0 ? `user ${os.userInfo().username};\n` : '';
  fs.writeFileSync(configFile, `${localUser}daemon off; master_process off; worker_processes 1;
pid "${temp}/nginx.pid"; error_log "${temp}/error.log";
events { worker_connections 4096; }
http {
  access_log off;
  client_body_temp_path "${temp}/client-body";
  proxy_temp_path "${temp}/proxy-temp";
  fastcgi_temp_path "${temp}/fastcgi-temp";
  uwsgi_temp_path "${temp}/uwsgi-temp";
  scgi_temp_path "${temp}/scgi-temp";
${originMap}
${server}
}\n`);
  const syntax = spawnSync(nginx, ['-p', temp + '/', '-c', configFile, '-t'], {encoding: 'utf8'});
  assert.equal(syntax.status, 0, syntax.stderr || syntax.error?.message);
  nginxProcess = launch(nginx, ['-p', temp + '/', '-c', configFile]);
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(nginxProcess.exitCode, null, 'Nginx 启动失败');
    try { if ((await request('/')).status === 200) return syntax.stderr.trim(); } catch {}
    await wait(50);
  }
  throw new Error('Nginx 就绪超时');
}

async function burst(count, urlPath, options = {}, concurrency = 200) {
  const statuses = {}, durations = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({length: Math.min(concurrency, count)}, async () => {
    while (next < count) {
      next++;
      const response = await request(urlPath, options);
      statuses[response.status] = (statuses[response.status] || 0) + 1;
      durations.push(response.durationMs);
    }
  }));
  durations.sort((a, b) => a - b);
  return {requests: count, concurrency, statuses, durationMs: Math.round(performance.now() - started),
    p95Ms: durations[Math.ceil(durations.length * .95) - 1]};
}

try {
  const version = spawnSync(nginx, ['-v'], {encoding: 'utf8'});
  assert.equal(version.status, 0, '需安装 Nginx 或设置 LABOPS_NGINX_PATH');
  nginxVersion = (version.stderr || version.stdout).trim();
  const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', path.join(temp, 'private.key'), '-out', path.join(temp, 'certificate.pem')], {encoding: 'utf8'});
  assert.equal(certificate.status, 0, '本地测试证书生成失败');
  const fixture = createReviewFixture(path.join(temp, 'native'));
  const nativePort = await port(), agentPort = await port(); proxyPort = await port();
  nativeBase = 'http://127.0.0.1:' + nativePort;
  const agentBase = 'http://127.0.0.1:' + agentPort;
  const publicBase = 'https://127.0.0.1:' + proxyPort;
  const native = launch(process.execPath, [path.join(root, 'Pages/serve.js')], {
    HOST: '127.0.0.1', PORT: String(nativePort), DATA_DIR: path.join(temp, 'native'),
    LABOPS_AGENT_URL: agentBase, LABOPS_PUBLIC_URL: publicBase, ENABLE_SEED_ACCOUNTS: '0',
    ENABLE_BASE_SEED: '0', REGISTER_OPEN: '0', INTEGRATION_READS_PER_MINUTE: '1000'});
  const agent = launch(process.execPath, [path.join(agentRoot, 'server/index.ts')], {
    HOST: '127.0.0.1', PORT: String(agentPort), LABOPS_DB_PATH: path.join(temp, 'agent.sqlite'),
    LABOPS_BUSINESS_URL: nativeBase, LABOPS_PUBLIC_URL: publicBase, LABOPS_AUTH_MODE: 'native',
    LABOPS_SECURE_COOKIE: '1', AGNES_API_KEY: '', DASHSCOPE_API_KEY: '', LOG_LEVEL: 'warn'});
  await ready(nativeBase, native); await ready(agentBase, agent);
  let cookie, conversationId;

  await record('N01 原部署模板在本地 TLS 环境通过 nginx -t 并启动', async () => {
    await startProxy(agentPort);
    return {nginxVersion, adapted: ['loopback listener and ports', 'temporary certificate paths', 'snippet path', 'upstream port', 'local single-process wrapper and temporary directories'],
      productionRatesUnchanged: true};
  });
  await record('N02 双入口、manifest、哈希资源和缓存策略穿过 TLS 代理', async () => {
    for (const entry of ['/index.html', '/mobile.html']) {
      const res = await request(entry); assert.equal(res.status, 200); assert.equal(res.headers['cache-control'], 'no-cache');
      assert.match(res.headers['content-type'], /text\/html/);
      for (const asset of new Set([...res.body.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(match => match[1]))) {
        const actual = await request(asset); assert.equal(actual.status, 200); assert.match(actual.headers['cache-control'], /immutable/);
        assert.equal(digest(actual.body), digest(fs.readFileSync(path.join(agentRoot, 'dist', asset.slice(1)))));
      }
    }
    const manifest = await request('/mobile.webmanifest'); assert.equal(manifest.status, 200);
    assert.match(manifest.headers['content-type'], /application\/manifest\+json/);
    const head = await request('/mobile.html', {method: 'HEAD'}); assert.equal(head.status, 200); assert.equal(head.body, '');
  });
  await record('N03 HTTPS 同源登录、Secure Cookie、会话恢复和来源拒绝正常', async () => {
    const login = await request('/api/auth/login', {method: 'POST', headers: {Origin: publicBase}, data: fixture.accounts.find(a => a.identity === 'admin')});
    assert.equal(login.status, 200); assert.equal(login.json.profile.identity, 'admin');
    const setCookie = login.headers['set-cookie'][0];
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax']) assert.ok(setCookie.includes(flag));
    cookie = setCookie.split(';')[0];
    const session = await request('/api/auth/session', {headers: {Cookie: cookie, Origin: publicBase}});
    assert.equal(session.json.authenticated, true);
    const denied = await request('/api/conversations', {method: 'POST', headers: {Cookie: cookie, Origin: 'https://untrusted.invalid'}, data: {mode: 'chat'}});
    assert.equal(denied.status, 403);
    const health = await request('/api/health'); assert.equal(health.json.version, '1.0.4.0');
  });
  await record('N04 真实实验室查询与范围引导的 SSE 完整、顺序正确、保存且幂等', async () => {
    const headers = {Cookie: cookie, Origin: publicBase};
    const create = await request('/api/conversations', {method: 'POST', headers, data: {title: '隔离代理验收', mode: 'chat'}});
    assert.equal(create.status, 200); conversationId = create.json.id;
    const url = '/api/conversations/' + conversationId + '/messages';
    const clientRequestId = crypto.randomUUID();
    const query = await request(url, {method: 'POST', headers, data: {message: `查询 E310 在 ${fixture.date} 的课表`, clientRequestId}});
    assert.equal(query.status, 200); assert.match(query.headers['content-type'], /text\/event-stream/);
    assert.equal(query.headers['cache-control'], 'no-cache, no-transform');
    const actual = events(query.body); assert.ok(actual.length > 3); assert.ok(actual.every((e, i) => i === 0 || e.seq > actual[i - 1].seq));
    assert.equal(actual.filter(e => e.type === 'run_completed').length, 1); assert.equal(actual.filter(e => e.type === 'run_failed').length, 0);
    assert.equal(actual.at(-1).type, 'end'); assert.match(query.body, /示例程序设计/);
    const repeat = await request(url, {method: 'POST', headers, data: {message: `查询 E310 在 ${fixture.date} 的课表`, clientRequestId}});
    assert.equal(repeat.status, 409);
    const scope = await request(url, {method: 'POST', headers, data: {message: '给我讲个笑话', clientRequestId: crypto.randomUUID()}});
    const done = events(scope.body).find(e => e.type === 'run_completed'); assert.equal(done.payload.engine, 'scope'); assert.equal(done.payload.toolCalls, 0);
    const history = await request('/api/conversations/' + conversationId, {headers});
    assert.equal(history.json.messages.length, 4); assert.equal(history.json.messages.at(-1).status, 'completed');
    assert.match(history.json.messages.at(-1).text, /服务范围/);
    assert.equal((await request('/api/auth/logout', {method: 'POST', headers, data: {}})).status, 200);
    assert.equal((await request('/api/auth/session', {headers})).json.authenticated, false);
    return {events: actual.length, savedMessages: 4, duplicateStatus: repeat.status};
  });

  const streams = [], received = [];
  probeServer = http.createServer((req, res) => {
    if (req.url.startsWith('/api/stream')) {
      const stream = {cancelled: false, completed: false}; streams.push(stream);
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'});
      res.write('data: first\n\n');
      const timers = [setTimeout(() => res.write('data: second\n\n'), 350),
        setTimeout(() => { stream.completed = true; res.end('data: final\n\n'); }, 1100)];
      res.on('close', () => { timers.forEach(clearTimeout); stream.cancelled = !stream.completed; });
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({method: req.method, path: req.url, bytes: body.length});
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: true, bytes: body.length, sha256: digest(body), host: req.headers.host,
        realIp: req.headers['x-real-ip'], forwardedFor: req.headers['x-forwarded-for'],
        forwardedProto: req.headers['x-forwarded-proto'], origin: req.headers.origin}));
    });
  });
  const probePort = await port(); await new Promise(resolve => probeServer.listen(probePort, '127.0.0.1', resolve));
  await startProxy(probePort);

  await record('N05 保留含端口 Host、HTTPS 来源和代理头，允许请求体完整到达', async () => {
    const data = Buffer.alloc(3 * 1024 * 1024, 97);
    const res = await request('/api/upload-probe', {method: 'POST', headers: {Origin: publicBase}, data});
    assert.equal(res.status, 200); assert.equal(res.json.host, '127.0.0.1:' + proxyPort);
    assert.equal(res.json.forwardedProto, 'https'); assert.equal(res.json.realIp, '127.0.0.1');
    assert.equal(res.json.forwardedFor, '127.0.0.1'); assert.equal(res.json.origin, publicBase);
    assert.equal(res.json.bytes, data.length); assert.equal(res.json.sha256, digest(data));
    return {uploadBytes: data.length};
  });
  await record('N06 SSE 首段及时到达，后续分段且客户端断开取消上游', async () => {
    const streamed = await request('/api/stream');
    assert.equal(streamed.status, 200); assert.match(streamed.body, /first[\s\S]*second[\s\S]*final/);
    assert.ok(streamed.arrivals[0] < 600); assert.ok(streamed.arrivals.at(-1) - streamed.arrivals[0] >= 800);
    const before = streams.length;
    await new Promise((resolve, reject) => {
      const req = https.request({hostname: '127.0.0.1', port: proxyPort, path: '/api/stream?cancel=1', agent: tlsAgent, rejectUnauthorized: false}, res => {
        res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
      }); req.on('error', reject); req.end();
    });
    for (let i = 0; i < 40 && !streams[before]?.cancelled; i++) await wait(25);
    assert.equal(streams[before].cancelled, true); assert.equal(streams[before].completed, false);
    return {firstChunkMs: streamed.arrivals[0], lastChunkMs: streamed.arrivals.at(-1), upstreamCancelled: true};
  });
  await record('N07 超过10MiB返回413且请求体不进入上游', async () => {
    const before = received.length;
    const res = await request('/api/oversized', {method: 'POST', data: Buffer.alloc(10 * 1024 * 1024 + 1)});
    assert.equal(res.status, 413); assert.equal(received.length, before);
  });
  await startProxy(probePort);
  await record('N08 同一IP写入突发返回429，读请求独立且伪造转发头不绕过', async () => {
    const write = await burst(100, '/api/write-probe', {method: 'POST', data: {}}, 100);
    assert.ok(write.statuses[200] >= 50); assert.ok(write.statuses[429] >= 20); assert.equal(Object.keys(write.statuses).length, 2);
    const spoof = await request('/api/write-probe', {method: 'POST', headers: {'X-Forwarded-For': '198.51.100.1'}, data: {}});
    assert.equal(spoof.status, 429);
    assert.equal((await request('/api/read-probe')).status, 200);
    assert.equal((await request('/api/read-probe', {method: 'HEAD'})).status, 200);
    return write;
  });
  await record('N09 读取额度耗尽时 GET/HEAD限流，静态600请求仍全部成功', async () => {
    const read = await burst(1000, '/api/read-probe');
    assert.ok(read.statuses[200] >= 200); assert.ok(read.statuses[429] > 0); assert.equal(Object.keys(read.statuses).length, 2);
    const head = await burst(50, '/api/read-probe', {method: 'HEAD'}, 50); assert.ok(head.statuses[429] > 0);
    const staticRequests = await burst(600, '/mobile.html'); assert.deepEqual(staticRequests.statuses, {'200': 600});
    return {read, head, static: staticRequests};
  });
  await record('N10 配置速率恢复额度，429后服务仍可正常接收请求', async () => {
    await wait(1500);
    assert.equal((await request('/api/write-probe', {method: 'POST', data: {}})).status, 200);
    assert.equal((await request('/api/read-probe')).status, 200);
  });

  const report = {version: '1.0.4.0', runType: 'isolated_real_nginx_tls', nginxVersion,
    at: new Date().toISOString(), passed: results.length, failed: 0, results,
    testScriptSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))),
    nginxBinarySha256: path.isAbsolute(nginx) ? digest(fs.readFileSync(nginx)) : undefined,
    wrapper: {masterProcess: false, workerProcesses: 1, temporaryPaths: true, loopbackOnly: true},
    templates: {'deploy/nginx-labops.conf': digest(serverTemplate), 'deploy/labops-proxy.conf': digest(proxyTemplate)},
    rates: {read: '120r/s', readBurst: 240, write: '120r/m', writeBurst: 60},
    actualServices: ['Native authentication', 'Agent persistence and lab/domain SSE', 'dual-entry dist'],
    controlledUpstream: ['delayed SSE and cancellation', 'body/hash and headers', 'proxy quotas and concurrent static traffic'],
    notRun: ['production_capacity', 'production_certificate', 'real_campus_network', 'physical_iOS', 'physical_Android', 'paid_models']};
  fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({passed: results.length, failed: 0, nginxVersion, output}));
} catch (error) {
  fs.writeFileSync(path.join(output, 'acceptance-failed.json'), JSON.stringify({version: '1.0.4.0', passed: results.length, failed: 1, results,
    error: String(error), logs, nginxLog: fs.existsSync(path.join(temp, 'error.log')) ? fs.readFileSync(path.join(temp, 'error.log'), 'utf8') : ''}, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  tlsAgent.destroy();
  for (const child of [...children].reverse()) await stop(child);
  if (probeServer) await new Promise(resolve => probeServer.close(resolve));
  fs.rmSync(temp, {recursive: true, force: true});
}
