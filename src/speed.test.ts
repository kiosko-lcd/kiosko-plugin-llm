// Tokens per second like FPS: the meter that reads answers, the histogram
// window, the "low" and TTFT per server type, the measuring proxy (against a
// fake Ollama and LM Studio, streaming and disconnects included) and the
// llm/speed widget.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { HistWindow, percentile } from './prom.ts';
import { ResponseMeter, framingOf, inspect, MAX_LINE } from './meter.ts';
import { METERED, SpeedLog, acquireProxy, closeAllProxies, pointsAtItself, proxyAt, startProxy } from './proxy.ts';
import { createState, demoData, readServers, type Fetch, type LlmData, type ServerStatus } from './llm.ts';
import { fmtSeconds, headline, pickSpeed, speedLevel } from './speed.ts';
import plugin, { startProxies } from './index.ts';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const near = (a: number | undefined, b: number, eps = 1e-6) => assert.ok(a !== undefined && Math.abs(a - b) < eps, `${a} ≈ ${b}`);

after(() => closeAllProxies());

/** Feeds a body to a meter in pieces of `size` bytes, one ms apart. */
function meterOf(body: string, contentType: string, size = 7, start = 1000) {
  const m = new ResponseMeter(contentType, start);
  const bytes = new TextEncoder().encode(body);
  let at = start + 100;
  for (let i = 0; i < bytes.length; i += size) m.feed(bytes.subarray(i, i + size), at++);
  return { m, end: at };
}

/* ---------- the meter ---------- */

test('meter: Ollama /api/chat stream (docs example), cut anywhere, even inside a UTF-8 character', () => {
  for (const size of [1, 3, 7, 64, 100_000]) {
    const { m, end } = meterOf(fx('ollama-chat-stream.ndjson'), 'application/x-ndjson', size);
    const r = m.finish(end, true)!;
    assert.equal(r.model, 'llama3.2');
    assert.equal(r.genTokens, 282, 'the server count, not the 3 chunks');
    assert.equal(r.estimated, false);
    near(r.decodeTps, 282 / 4.535599, 1e-6);
    near(r.promptTps, 26 / 0.342546, 1e-6);
    assert.equal(r.promptTokens, 26);
    assert.equal(r.streamed, true);
    assert.equal(r.ttft, (r.firstAt! - 1000) / 1000, 'streamed: the wall clock to the first token');
    assert.equal(m.chunks, 3);
  }
});

test('meter: Ollama /api/generate not streamed (docs example): the server figures, TTFT = load + prompt', () => {
  const { m, end } = meterOf(fx('ollama-generate.json'), 'application/json; charset=utf-8');
  const r = m.finish(end, true)!;
  assert.equal(r.model, 'gemma4');
  assert.equal(r.genTokens, 18);
  near(r.decodeTps, 18 / 0.052479709);
  near(r.ttft, 0.013074791 + 0.101397084);
  assert.equal(r.streamed, false);
});

test("meter: Ollama's OpenAI stream with timings and usage; Chinese text cut mid-character", () => {
  const { m, end } = meterOf(fx('ollama-v1-stream.sse'), 'text/event-stream', 2);
  const r = m.finish(end, true)!;
  assert.equal(r.model, 'qwen3:32b');
  assert.equal(r.genTokens, 42, 'timings first, usage does not override');
  near(r.decodeTps, 42);
  near(r.promptTps, 300);
  assert.equal(m.chunks, 2, '你, 好; the empty final delta is no token');
});

test('meter: LM Studio REST v1 stream (chat.end stats) and v0 (stats on the answer)', () => {
  const v1 = meterOf(fx('lmstudio-v1-chat.sse'), 'text/event-stream');
  const r1 = v1.m.finish(v1.end, true)!;
  assert.equal(r1.model, 'google/gemma-4-26b-a4b');
  assert.equal(r1.genTokens, 586);
  near(r1.decodeTps, 29.753900615398926);
  assert.equal(v1.m.chunks, 2);
  const v0 = meterOf(fx('lmstudio-v0-chat.json'), 'application/json');
  const r0 = v0.m.finish(v0.end, true)!;
  assert.equal(r0.model, 'granite-3.0-2b-instruct');
  assert.equal(r0.genTokens, 53);
  near(r0.decodeTps, 51.43709529007664);
  near(r0.ttft, 0.111);
});

test('meter: an OpenAI stream with no usage is counted one token per chunk, and says so', () => {
  const chunk = (c: string) => `data: ${JSON.stringify({ object: 'chat.completion.chunk', model: 'm', choices: [{ delta: { content: c } }] })}\n\n`;
  const { m, end } = meterOf(['a', 'b', 'c', 'd', 'e'].map(chunk).join('') + 'data: [DONE]\n\n', 'text/event-stream; charset=utf-8', 40);
  const r = m.finish(end, true)!;
  assert.equal(r.genTokens, 5);
  assert.equal(r.estimated, true);
  assert.ok(r.decodeTps! > 0);
});

test('meter: a line too long is skipped, the stream still read; garbage and other routes ignored', () => {
  const huge = `{"model":"m","done":false,"response":"${'x'.repeat(MAX_LINE + 10)}"}\n`;
  const { m, end } = meterOf(huge + '{"model":"m","done":true,"eval_count":9,"eval_duration":1000000000}\nnot json\n', 'application/x-ndjson', 65536);
  const r = m.finish(end, true)!;
  assert.equal(r.genTokens, 9);
  near(r.decodeTps, 9);
  assert.equal(new ResponseMeter('application/json', 0).finish(1, true), undefined, 'nothing measurable');
  assert.equal(framingOf('application/x-ndjson'), 'ndjson');
  assert.equal(framingOf(undefined), 'json');
  assert.equal(inspect({ type: 'response.output_text.delta', delta: 'x' }).token, true, 'OpenAI Responses');
  assert.equal(inspect({ type: 'message_delta', usage: { output_tokens: 7 } }).usage.genTokens, 7, 'Anthropic Messages');
  for (const p of ['/api/chat', '/api/generate', '/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/messages', '/api/v0/chat/completions', '/api/v1/chat', '/completion']) assert.ok(METERED.test(p), p);
  for (const p of ['/api/tags', '/api/ps', '/api/pull', '/v1/models', '/api/embed', '/v1/embeddings']) assert.ok(!METERED.test(p), p);
});

/* ---------- histograms ---------- */

test('histogram window: quantiles over the last minutes, not one poll; a restart starts again', () => {
  const w = new HistWindow(60_000);
  w.push(0, [[0.1, 0], [1, 0], [Infinity, 0]]);
  assert.equal(w.quantile(0.5), undefined, 'one reading: nothing yet');
  w.push(5_000, [[0.1, 10], [1, 10], [Infinity, 10]]);
  w.push(10_000, [[0.1, 10], [1, 10], [Infinity, 10]]);
  assert.equal(w.count(), 10, 'an idle poll keeps what came before');
  near(w.quantile(0.5), 0.05);
  w.push(70_000, [[0.1, 10], [1, 20], [Infinity, 20]]);
  assert.equal(w.count(), 10, 'older than the span: gone');
  near(w.quantile(0.5), 0.55);
  w.push(75_000, [[0.1, 1], [1, 1], [Infinity, 1]]);
  assert.equal(w.count(), 0, 'restart');
  assert.equal(percentile(0.1, [50, 10, 40, 30, 20]), 10);
  assert.equal(percentile(0.5, [50, 10, 40, 30, 20]), 30);
  assert.equal(percentile(0.5, []), undefined);
});

function fakeFetch(routes: () => Record<string, string>): Fetch {
  return async (url) => {
    const body = routes()[url];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? '' };
  };
}

test('vLLM: TTFT p50/p90, time per output token and the low from the histograms', async () => {
  let metrics = fx('vllm-tpot-1.txt');
  const f = fakeFetch(() => ({ 'http://v:8000/metrics': metrics }));
  const state = createState();
  const ep = [{ name: 'vllm', kind: 'vllm' as const, url: 'http://v:8000' }];
  await readServers(ep, { fetch: f, now: 0, state });
  metrics = fx('vllm-tpot-2.txt');
  const s = (await readServers(ep, { fetch: f, now: 5000, state })).servers[0]!;
  near(s.genTps, 60);
  near(s.tpotP50, 0.025 + 0.025 * (40 / 70));
  near(s.tpotP90, 0.075);
  near(s.lowTps, 1 / 0.075);
  near(s.decodeTps, 1 / (0.025 + 0.025 * (40 / 70)));
  near(s.ttftP50, 0.09);
  near(s.ttftP90, 0.15 + 0.05 * (2 / 7));
  assert.equal(s.measured, 'server');
  // Idle poll: same counters, the figures of the last minutes stay.
  const idle = (await readServers(ep, { fetch: f, now: 10_000, state })).servers[0]!;
  assert.equal(idle.genTps, 0);
  near(idle.lowTps, 1 / 0.075);
});

test('TGI: the low from the mean time per token of each request', async () => {
  let metrics = fx('tgi-metrics.txt');
  const f = fakeFetch(() => ({ 'http://t/info': '{"model_id":"Qwen/Qwen2.5-7B-Instruct"}', 'http://t/metrics': metrics }));
  const state = createState();
  const ep = [{ name: 'tgi', kind: 'tgi' as const, url: 'http://t' }];
  await readServers(ep, { fetch: f, now: 0, state });
  metrics = metrics.replace(/(duration_bucket\{le="[^"]+"\}) (\d+)/g, (_, a: string, n: string) => `${a} ${Number(n) * 2}`);
  const s = (await readServers(ep, { fetch: f, now: 5000, state })).servers[0]!;
  near(s.tpotP90, 0.05);
  near(s.lowTps, 20);
});

test('llama.cpp: decode speed from the seconds spent decoding; the low is the slow tenth of the polls', async () => {
  const text = (tokens: number, seconds: number) => `llamacpp:tokens_predicted_total ${tokens}\nllamacpp:tokens_predicted_seconds_total ${seconds}\nllamacpp:requests_processing 1\n`;
  let metrics = text(0, 0);
  const f = fakeFetch(() => ({ 'http://l/health': '{"status":"ok"}', 'http://l/metrics': metrics }));
  const state = createState();
  const ep = [{ name: 'l', kind: 'llamacpp' as const, url: 'http://l' }];
  await readServers(ep, { fetch: f, now: 0, state });
  let tok = 0, sec = 0, last: ServerStatus | undefined;
  for (const [i, speed] of [40, 41, 39, 40, 12, 40, 42, 40, 41, 40].entries()) {
    tok += 200;
    sec += 200 / speed;
    metrics = text(tok, sec);
    last = (await readServers(ep, { fetch: f, now: (i + 1) * 5000, state })).servers[0]!;
  }
  near(last!.decodeTps, 40);
  near(last!.lowTps, 12, 1e-6);
  near(last!.genTps, 40, 1e-9);
});

test('LM Studio: the loaded models from its REST API; other OpenAI servers keep their list', async () => {
  const f = fakeFetch(() => ({ 'http://lms:1234/v1/models': '{"data":[{"id":"google/gemma-4-26b-a4b"},{"id":"deepseek-r1"}]}', 'http://lms:1234/api/v1/models': fx('lmstudio-v1-models.json') }));
  const s = (await readServers([{ name: 'lms', kind: 'openai', url: 'http://lms:1234/v1' }], { fetch: f, now: 0, state: createState() })).servers[0]!;
  assert.deepEqual(s.models, [{ name: 'google/gemma-4-26b-a4b', contextLength: 4096 }]);
  assert.equal(s.installed, 3);
  const g = fakeFetch(() => ({ 'http://o/v1/models': '{"data":[{"id":"a"}]}' }));
  assert.deepEqual((await readServers([{ name: 'o', kind: 'openai', url: 'http://o' }], { fetch: g, now: 0, state: createState() })).servers[0]!.models, [{ name: 'a' }]);
});

test('Ollama through the proxy: tokens/s, TTFT and the low per model; the proxy says when it is off', async () => {
  const log = new SpeedLog();
  for (let i = 0; i < 10; i++) {
    const m = log.begin('application/x-ndjson', 10_000 + i * 1000);
    m.feed(Buffer.from('{"model":"qwen3:32b","done":false,"response":"x"}\n'), 10_000 + i * 1000 + 300);
    m.feed(Buffer.from(`{"model":"qwen3:32b","done":true,"eval_count":40,"eval_duration":${i === 3 ? 4e9 : 1e9},"prompt_eval_count":100,"prompt_eval_duration":2e8}\n`), 10_000 + i * 1000 + 900);
    m.finish(10_000 + i * 1000 + 900, true);
  }
  const ollama = fakeFetch(() => ({ 'http://o:11434/api/version': '{"version":"0.40.17"}', 'http://o:11434/api/ps': '{"models":[]}' }));
  const ep = { name: 'ollama', kind: 'ollama' as const, url: 'http://o:11434', proxyPort: 11435 };
  const view = { listen: '127.0.0.1:11435', listening: true, log };
  const s = (await readServers([ep], { fetch: ollama, now: 20_000, state: createState(), proxyOf: () => view })).servers[0]!;
  assert.equal(s.measured, 'proxy');
  near(s.decodeTps, 40);
  near(s.lowTps, 10, 1e-9);
  near(s.ttftP50, 0.3);
  assert.ok(s.genTps! > 0, 'the last answers fall in the window');
  assert.equal(s.proxy?.requests, 10);
  assert.deepEqual(s.speeds?.map((m) => m.model), ['qwen3:32b']);
  const off = (await readServers([ep], { fetch: ollama, now: 20_000, state: createState(), proxyOf: () => undefined })).servers[0]!;
  assert.equal(off.proxy?.listening, false);
  assert.equal(off.genTps, undefined);
  const none = (await readServers([{ ...ep, proxyPort: 0 }], { fetch: ollama, now: 20_000, state: createState() })).servers[0]!;
  assert.equal(none.proxy, undefined, 'no proxy asked: none mentioned');
});

/* ---------- the proxy, end to end ---------- */

interface Fake {
  url: string;
  port: number;
  closedEarly: number;
  seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[];
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake Ollama + LM Studio: streams NDJSON and SSE with pauses, and notices clients that leave. */
async function fakeServer(): Promise<Fake> {
  const fake: Fake = { url: '', port: 0, closedEarly: 0, seen: [], close: async () => {} };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    fake.seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    let gone = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        gone = true;
        fake.closedEarly++;
      }
    });
    if (req.url === '/api/tags') return res.writeHead(200, { 'content-type': 'application/json', 'x-up': 'yes' }).end('{"models":[]}');
    if (req.url === '/api/chat') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const w of ['你', '好', '世', '界']) {
        res.write(`${JSON.stringify({ model: 'qwen3:8b', message: { role: 'assistant', content: w }, done: false })}\n`);
        await sleep(15);
      }
      return res.end(`${JSON.stringify({ model: 'qwen3:8b', message: { role: 'assistant', content: '' }, done: true, eval_count: 4, eval_duration: 50_000_000, prompt_eval_count: 9, prompt_eval_duration: 10_000_000 })}\n`);
    }
    if (req.url === '/api/generate') {
      // Endless until the client goes.
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      while (!gone) {
        res.write(`${JSON.stringify({ model: 'slow', response: 'x', done: false })}\n`);
        await sleep(10);
      }
      return;
    }
    if (req.url === '/api/v1/chat') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const part of fx('lmstudio-v1-chat.sse').split('\n\n').filter(Boolean)) {
        res.write(`${part}\n\n`);
        await sleep(5);
      }
      return res.end();
    }
    res.writeHead(404).end('nope');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  fake.port = (server.address() as AddressInfo).port;
  fake.url = `http://127.0.0.1:${fake.port}`;
  fake.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return fake;
}

async function request(port: number, path: string, body?: string, opts: { abortAfter?: number } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer client-key' } }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        out += c;
        if (opts.abortAfter && out.length >= opts.abortAfter) req.destroy();
      });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: out }));
      res.on('close', () => resolve({ status: res.statusCode!, headers: res.headers, body: out }));
    });
    req.on('error', (e) => (opts.abortAfter ? resolve({ status: 0, headers: {}, body: '' }) : reject(e)));
    req.end(body);
  });
}

test('proxy: passes requests and answers through unchanged, streaming included, and measures them', async () => {
  const fake = await fakeServer();
  const p = startProxy({ upstream: fake.url, host: '127.0.0.1', port: 0 });
  await p.ready;
  assert.equal(p.listening, true);
  const port = p.port!;
  // Not measured: piped as is, headers both ways.
  const tags = await request(port, '/api/tags');
  assert.equal(tags.body, '{"models":[]}');
  assert.equal(tags.headers['x-up'], 'yes');
  assert.equal(fake.seen[0]!.headers.authorization, 'Bearer client-key', "the client's own key reaches the server");
  assert.equal(fake.seen[0]!.headers.host, `127.0.0.1:${fake.port}`);
  // Streamed: same bytes, chunk by chunk.
  const chat = await request(port, '/api/chat', '{"model":"qwen3:8b","messages":[{"role":"user","content":"秘密"}]}');
  assert.equal(chat.headers['content-type'], 'application/x-ndjson');
  assert.equal(chat.body.split('\n').filter(Boolean).length, 5);
  assert.ok(chat.body.includes('世'));
  assert.equal(fake.seen[1]!.body, '{"model":"qwen3:8b","messages":[{"role":"user","content":"秘密"}]}', 'request body forwarded untouched');
  const lms = await request(port, '/api/v1/chat', '{"model":"google/gemma-4-26b-a4b","input":"hi"}');
  assert.equal(lms.body, fx('lmstudio-v1-chat.sse'));
  const snap = p.log.snapshot(Date.now(), 60_000);
  assert.equal(snap.requests, 2, 'only the inference routes');
  assert.deepEqual(snap.models.map((m) => m.model).sort(), ['google/gemma-4-26b-a4b', 'qwen3:8b']);
  const qwen = snap.models.find((m) => m.model === 'qwen3:8b')!;
  assert.ok(qwen.ttftP50! >= 0 && qwen.ttftP50! < 1);
  // Nothing of the conversation is kept: the log holds numbers and model names only.
  const kept = JSON.stringify(snap) + JSON.stringify((p.log as unknown as { records: unknown }).records);
  for (const secret of ['秘密', '你', '世', 'Hello', 'client-key']) assert.ok(!kept.includes(secret), secret);
  await p.close();
  await fake.close();
});

test('proxy: a client that leaves mid-answer stops the upstream too; a dead upstream is a 502', async () => {
  const fake = await fakeServer();
  const p = startProxy({ upstream: fake.url, host: '127.0.0.1', port: 0 });
  await p.ready;
  await request(p.port!, '/api/generate', '{"model":"slow"}', { abortAfter: 200 });
  for (let i = 0; i < 50 && fake.closedEarly === 0; i++) await sleep(10);
  assert.equal(fake.closedEarly, 1, 'the server saw the client go');
  for (let i = 0; i < 50 && p.log.active > 0; i++) await sleep(10);
  assert.equal(p.log.active, 0);
  const rec = (p.log as unknown as { records: { complete: boolean; estimated: boolean; genTokens: number }[] }).records[0]!;
  assert.equal(rec.complete, false);
  assert.equal(rec.estimated, true);
  assert.ok(rec.genTokens > 0);
  // The proxy keeps serving.
  assert.equal((await request(p.port!, '/api/tags')).status, 200);
  await fake.close();
  const dead = await request(p.port!, '/api/chat', '{}');
  assert.equal(dead.status, 502);
  assert.match(dead.body, /did not answer/);
  await p.close();
});

test('proxy: local by default, never pointed at itself, one per port; the source starts and stops it', async () => {
  const fake = await fakeServer();
  assert.equal(pointsAtItself('http://127.0.0.1:11435', '127.0.0.1', 11435), true);
  assert.equal(pointsAtItself('http://localhost:11435', '0.0.0.0', 11435), true);
  assert.equal(pointsAtItself('http://127.0.0.1:11434', '127.0.0.1', 11435), false);
  const loop = startProxy({ upstream: 'http://127.0.0.1:19999', host: '127.0.0.1', port: 19999 });
  await loop.ready;
  assert.equal(loop.listening, false);
  assert.equal(loop.error, 'points at itself');
  // A free port, found by the system.
  const probe = http.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  const stop = startProxies([{ name: 'ollama', kind: 'ollama', url: fake.url, proxyPort: port }, { name: 'off', kind: 'ollama', url: fake.url, proxyPort: 0 }]);
  const p = proxyAt('127.0.0.1', port)!;
  await p.ready;
  assert.equal(p.listening, true);
  assert.equal(p.listen, `127.0.0.1:${port}`, 'loopback unless the user sets a host');
  const again = acquireProxy({ upstream: fake.url, host: '127.0.0.1', port });
  assert.equal(proxyAt('127.0.0.1', port), p, 'shared, not a second listener');
  again();
  assert.equal(proxyAt('127.0.0.1', port), p, 'still held by the source');
  // The port is taken: the error says so.
  const clash = startProxy({ upstream: fake.url, host: '127.0.0.1', port, retryMs: [] });
  await clash.ready;
  assert.equal(clash.error, `port ${port} in use`);
  stop();
  assert.equal(proxyAt('127.0.0.1', port), undefined);
  // Options changed: the source stops and starts again at once, on the same port.
  const stop2 = startProxies([{ name: 'ollama', kind: 'ollama', url: fake.url, proxyPort: port }]);
  await proxyAt('127.0.0.1', port)!.ready;
  assert.equal(proxyAt('127.0.0.1', port)!.listening, true);
  assert.equal((await request(port, '/api/tags')).status, 200);
  stop2();
  await sleep(50);
  await assert.rejects(request(port, '/api/tags'), 'closed');
  await fake.close();
});

test('source: off by default, both proxy options flagged as network', () => {
  const src = plugin.sources![0]!;
  const item = (src.options as { props: { endpoints: { item: { props: Record<string, { default: unknown; risk?: unknown }> } } } }).props.endpoints.item.props;
  assert.equal(item.proxyPort!.default, 0);
  assert.equal(item.proxyHost!.default, '127.0.0.1');
  assert.equal(item.proxyPort!.risk, 'network');
  assert.equal(item.proxyHost!.risk, 'network');
  assert.equal(typeof src.watch, 'function');
  const stop = src.watch!({ options: { endpoints: [{ name: 'o', kind: 'ollama', url: 'http://127.0.0.1:11434', token: '', proxyPort: 0, proxyHost: '127.0.0.1' }] } } as never, () => {});
  stop();
});

/* ---------- the widget ---------- */

test('speed widget: which server, the low and the thresholds, the figure while idle', () => {
  const now = 1_000_000;
  const d = demoData(now, 'zh-Hans');
  assert.equal(pickSpeed(d, { server: '', model: '' })!.s.name, 'vllm', 'the fastest generating now');
  const o = pickSpeed(d, { server: 'ollama', model: '' })!;
  assert.equal(o.title, 'ollama · qwen3:32b');
  assert.equal(o.lowTps, 31.4);
  assert.equal(pickSpeed(d, { server: '', model: 'qwen3:*' })!.model, 'qwen3:32b', 'by model, from the proxy');
  assert.equal(pickSpeed(d, { server: '', model: 'Qwen/Qwen3-30B-A3B' })!.s.name, 'vllm', 'by model a server holds');
  assert.equal(pickSpeed(d, { server: 'nope', model: '' }), undefined);
  assert.equal(pickSpeed(d, { server: 'lm-studio', model: '' })!.s.reachable, false, 'asked for: shown down');
  const quiet: LlmData = { at: now, servers: d.servers.map((s) => ({ ...s, genTps: s.genTps === undefined ? undefined : 0, running: 0 })) };
  const q = pickSpeed(quiet, { server: '', model: '' })!;
  assert.equal(q.on, false);
  assert.equal(q.s.name, 'ollama', 'idle: the one that generated last');
  assert.deepEqual(headline(q), { value: 42.1, live: false }, 'idle: the recent answers, not a zero');
  assert.equal(speedLevel(8, { warnBelow: 10, alertBelow: 5 }), 'warn');
  assert.equal(speedLevel(3, { warnBelow: 10, alertBelow: 5 }), 'alert');
  assert.equal(speedLevel(0, { warnBelow: 10, alertBelow: 5 }), 'normal', 'idle is not slow');
  assert.equal(speedLevel(3, { warnBelow: 0, alertBelow: 0 }), 'normal');
  assert.equal(fmtSeconds(0.34), '0.34 s');
  assert.equal(fmtSeconds(0.05), '50 ms');
  assert.equal(fmtSeconds(12.4), '12 s');
  const bare: LlmData = { at: now, servers: [{ name: 'ollama', kind: 'ollama', url: 'u', reachable: true, models: [], history: [] }] };
  assert.equal(pickSpeed(bare, { server: '', model: '' }), undefined, 'Ollama with no proxy: nothing to show');
});

test('speed widget: text never under 11 px (CJK), in every language and size', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const { THEMES, createBaseContext } = await import('@kiosko/sdk');
  const kit = await import('@loksly/lcd-canvas-kit');
  const w = plugin.widgets!.find((x) => x.id === 'speed')!;
  const options = Object.fromEntries(Object.entries((w.options as { props: Record<string, { default: unknown }> }).props).map(([k, f]) => [k, f.default]));
  const now = Date.parse('2026-11-21T10:00:00Z');
  for (const locale of ['en', 'es', 'de', 'zh-Hant', 'zh-Hans']) {
    for (const [bw, bh] of [[960, 462], [480, 230], [300, 160], [200, 90], [140, 50]] as const) {
      const sizes: number[] = [];
      const spy = { ...kit, drawTracked: (g: never, s: string, x: number, y: number, o: { size: number }) => (s && sizes.push(o.size), kit.drawTracked(g, s, x, y, o as never)), drawClipped: (g: never, s: string, x: number, y: number, mw: number, o: { size: number }) => (s && mw > 0 && sizes.push(o.size), kit.drawClipped(g, s, x, y, mw, o as never)) };
      const g = createCanvas(bw, bh).getContext('2d');
      w.render(g as never, { ...createBaseContext({ now, locale }), options, data: undefined, sources: { 'llm/servers': demoData(now, locale) }, working: true, box: { x: 0, y: 0, w: bw, h: bh }, theme: THEMES[0]!, fonts: THEMES[0]!.fonts, kit: spy, canvas: { createCanvas }, preview: true } as never);
      assert.ok(sizes.length > 0, `${locale} ${bw}×${bh}`);
      assert.ok(Math.min(...sizes) >= 11, `${locale} ${bw}×${bh}: ${Math.min(...sizes)} px`);
    }
  }
});
