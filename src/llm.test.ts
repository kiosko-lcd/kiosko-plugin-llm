import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bucketDelta, buckets, counterRate, parseProm, quantile, sum } from './prom.ts';
import { baseUrl, busy, countdown, createState, demoData, fmtBytes, fmtCtx, readServers, vllmFromMetrics, type Fetch } from './llm.ts';
import plugin, { congested, modelRows, queueServers, rateServers, serverBudget, serversOf } from './index.ts';

const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

/** A fetch that serves saved responses by URL: a string body, an HTTP status, or a network error. */
function fakeFetch(routes: Record<string, string | number | Error>, seen: { url: string; headers: Record<string, string> }[] = []): Fetch {
  return async (url, init) => {
    seen.push({ url, headers: init.headers });
    const r = routes[url];
    if (r === undefined) return { ok: false, status: 404, text: async () => 'not found' };
    if (r instanceof Error) throw r;
    if (typeof r === 'number') return { ok: false, status: r, text: async () => '' };
    return { ok: true, status: 200, text: async () => r };
  };
}

test('prometheus: samples, labels, escapes, +Inf and comments', () => {
  const ms = parseProm('# HELP x y\n# TYPE a counter\na_total{k="v",q="a\\"b"} 12.5\nb 3 1700000000000\nc{le="+Inf"} 4\nbad line here\nd NaN\n');
  assert.equal(ms.length, 3);
  assert.deepEqual(ms[0], { name: 'a_total', labels: { k: 'v', q: 'a"b' }, value: 12.5 });
  assert.equal(ms[1]!.value, 3, 'timestamp ignored');
  assert.equal(sum(ms, 'missing', 'b'), 3, 'first family present');
  assert.equal(sum(ms, 'missing'), undefined);
});

test('prometheus: counter rates survive resets', () => {
  assert.equal(counterRate(100, 600, 5000), 100);
  assert.equal(counterRate(1000, 50, 5000), 10, 'restart: counts from zero');
  assert.equal(counterRate(undefined, 50, 5000), undefined);
  assert.equal(counterRate(1, 2, 0), undefined);
});

test('prometheus: histogram quantiles over the poll window', () => {
  const a = buckets(parseProm(fx('vllm-metrics-1.txt')), 'vllm:time_to_first_token_seconds');
  const b = buckets(parseProm(fx('vllm-metrics-2.txt')), 'vllm:time_to_first_token_seconds');
  assert.equal(a.at(-1)![0], Infinity);
  const d = bucketDelta(a, b);
  assert.equal(d.at(-1)![1], 10);
  // 10 new: 2 ≤0.25, 8 ≤0.5, 10 ≤1. p50 → rank 5 in (0.25,0.5]: 0.25 + 0.25·3/6.
  assert.ok(Math.abs(quantile(0.5, d)! - 0.375) < 1e-9);
  assert.ok(Math.abs(quantile(0.95, d)! - 0.875) < 1e-9);
  assert.equal(quantile(0.5, bucketDelta(b, b)), undefined, 'nothing observed');
  assert.equal(bucketDelta(undefined, b).length, 0, 'first poll has no window');
  assert.deepEqual(bucketDelta([[1, 50], [Infinity, 60]], [[1, 3], [Infinity, 4]]), [[1, 3], [Infinity, 4]], 'reset');
  assert.equal(quantile(0.99, [[1, 0], [Infinity, 4]]), 1, 'top bucket → highest finite bound');
});

test('vLLM: gauges from /metrics, rates and TTFT between two polls', async () => {
  const state = createState();
  let metrics = fx('vllm-metrics-1.txt');
  const models = JSON.stringify({ object: 'list', data: [{ id: 'meta-llama/Llama-3.1-8B-Instruct', object: 'model', max_model_len: 131072 }] });
  const ep = [{ name: 'box', kind: 'vllm' as const, url: '192.168.1.41:8000/v1/', token: 's3cret' }];
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const f: Fetch = (url, init) => fakeFetch({ 'http://192.168.1.41:8000/metrics': metrics, 'http://192.168.1.41:8000/v1/models': models, 'http://192.168.1.41:8000/version': '{"version":"0.11.0"}' }, seen)(url, init);
  const first = (await readServers(ep, { fetch: f, now: 1_000_000, state })).servers[0]!;
  assert.equal(first.reachable, true);
  assert.equal(first.running, 3);
  assert.equal(first.waiting, 0);
  assert.equal(first.kvUsage, 0.3712);
  assert.equal(first.genTps, undefined, 'no rate on the first poll');
  assert.equal(first.requestsTotal, 9310);
  assert.equal(first.version, '0.11.0');
  assert.deepEqual(first.models, [{ name: 'meta-llama/Llama-3.1-8B-Instruct', contextLength: 131072 }]);
  assert.equal(seen[0]!.headers.Authorization, 'Bearer s3cret');
  metrics = fx('vllm-metrics-2.txt');
  const second = (await readServers(ep, { fetch: f, now: 1_005_000, state })).servers[0]!;
  assert.equal(second.genTps, 85);
  assert.equal(second.promptTps, 412);
  assert.ok(Math.abs(second.ttftP50! - 0.375) < 1e-9);
  assert.deepEqual(second.history, [[1_005_000, 85]]);
  assert.ok(busy(second));
  // Older vLLM names the KV gauge gpu_cache_usage_perc.
  assert.equal(vllmFromMetrics(parseProm('vllm:gpu_cache_usage_perc{model_name="m"} 0.5')).kvUsage, 0.5);
});

test('Ollama: loaded models with VRAM, context and keep-alive; no tokens/s', async () => {
  const f = fakeFetch({ 'http://127.0.0.1:11434/api/version': '{"version":"0.12.6"}', 'http://127.0.0.1:11434/api/ps': fx('ollama-ps.json'), 'http://127.0.0.1:11434/api/tags': fx('ollama-tags.json') });
  const s = (await readServers([{ name: 'ollama', kind: 'ollama', url: 'http://127.0.0.1:11434' }], { fetch: f, state: createState() })).servers[0]!;
  assert.equal(s.version, '0.12.6');
  assert.equal(s.installed, 3);
  assert.equal(s.models.length, 2);
  assert.deepEqual(s.models[0], { name: 'qwen2.5-coder:32b', sizeBytes: 23343271936, vramBytes: 23343271936, contextLength: 32768, expiresAt: '2026-11-09T10:04:12.123456789+01:00', quantization: 'Q4_K_M', parameters: '32.8B' });
  assert.equal(s.models[1]!.vramBytes, 1827478528, 'half on the CPU');
  assert.equal(s.genTps, undefined);
  assert.equal(s.running, undefined);
  assert.equal(busy(s), false);
  assert.equal(countdown(s.models[0]!.expiresAt, Date.parse('2026-11-09T10:00:00+01:00')), '4:12');
  assert.equal(countdown(s.models[1]!.expiresAt, Date.now()), '∞', 'keep_alive -1');
});

test('llama.cpp: slots, props and --metrics', async () => {
  const state = createState();
  const base = 'http://10.0.0.5:8080';
  let metrics = fx('llamacpp-metrics-1.txt');
  const f: Fetch = (url, init) => fakeFetch({ [`${base}/health`]: '{"status":"ok"}', [`${base}/props`]: fx('llamacpp-props.json'), [`${base}/slots`]: fx('llamacpp-slots.json'), [`${base}/metrics`]: metrics })(url, init);
  const ep = [{ name: 'gemma', kind: 'llamacpp' as const, url: base }];
  const a = (await readServers(ep, { fetch: f, now: 0, state })).servers[0]!;
  assert.deepEqual(a.models, [{ name: 'gemma-3-27b-it-Q4_K_M', contextLength: 8192 }]);
  assert.equal(a.version, 'b6710-74b8fc17');
  assert.deepEqual(a.slots, [{ id: 0, busy: true, nCtx: 8192, decoded: 271 }, { id: 1, busy: false, nCtx: 8192, decoded: 0 }]);
  assert.equal(a.running, 1);
  assert.equal(a.waiting, 0);
  assert.equal(a.kvUsage, 0.21);
  assert.equal(a.genTps, 37.98, 'gauge while busy on the first poll');
  assert.equal(a.genTokensTotal, 9120);
  metrics = fx('llamacpp-metrics-2.txt');
  const b = (await readServers(ep, { fetch: f, now: 5000, state })).servers[0]!;
  assert.equal(b.genTps, 38, 'then the counter rate');
  assert.equal(b.promptTps, 0);
});

test('llama.cpp without --metrics or /slots still reports the model', async () => {
  const base = 'http://10.0.0.5:8080';
  const f = fakeFetch({ [`${base}/health`]: '{"status":"ok"}', [`${base}/props`]: fx('llamacpp-props.json'), [`${base}/slots`]: 501, [`${base}/metrics`]: 501 });
  const s = (await readServers([{ name: 'x', kind: 'llamacpp', url: base }], { fetch: f, state: createState() })).servers[0]!;
  assert.equal(s.reachable, true);
  assert.equal(s.models[0]!.name, 'gemma-3-27b-it-Q4_K_M');
  assert.equal(s.running, undefined);
  assert.equal(s.kvUsage, undefined);
});

test('TGI and OpenAI-compatible, best effort', async () => {
  const f = fakeFetch({
    'http://tgi:80/info': '{"model_id":"mistralai/Mistral-7B-Instruct-v0.3","version":"3.3.6","max_total_tokens":8192}',
    'http://tgi:80/metrics': 'tgi_queue_size 4\ntgi_batch_current_size 8\ntgi_request_generated_tokens_sum 1000\ntgi_request_success 12\n',
    'http://studio:1234/v1/models': '{"data":[{"id":"qwen3-14b"},{"id":"text-embedding-nomic"}]}',
  });
  const d = await readServers([{ name: 'tgi', kind: 'tgi', url: 'http://tgi:80' }, { name: 'studio', kind: 'openai', url: 'http://studio:1234/v1' }], { fetch: f, state: createState() });
  assert.equal(d.servers[0]!.waiting, 4);
  assert.equal(d.servers[0]!.running, 8);
  assert.equal(d.servers[0]!.models[0]!.contextLength, 8192);
  assert.deepEqual(d.servers[1]!.models.map((m) => m.name), ['qwen3-14b', 'text-embedding-nomic']);
});

test('a dead or hung endpoint does not block the others', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const routes = fakeFetch({ 'http://ok:1234/v1/models': '{"data":[{"id":"m"}]}', 'http://dead:11434/api/version': refused, 'http://busy:8000/metrics': 503 });
  // `hung` never answers: only the timeout frees it.
  const f: Fetch = (url, init) => url.startsWith('http://hung') ? new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) : routes(url, init);
  const t0 = Date.now();
  const d = await readServers([
    { name: 'dead', kind: 'ollama', url: 'http://dead:11434' },
    { name: 'hung', kind: 'vllm', url: 'http://hung:8000' },
    { name: 'busy', kind: 'vllm', url: 'http://busy:8000' },
    { name: 'ok', kind: 'openai', url: 'http://ok:1234' },
    { name: 'blank', kind: 'openai', url: ' ' },
  ], { fetch: f, state: createState(), timeoutMs: 100 });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(d.servers.map((s) => [s.name, s.reachable, s.error]), [['dead', false, 'ECONNREFUSED'], ['hung', false, 'timeout'], ['busy', false, 'HTTP 503 on /metrics'], ['ok', true, undefined]]);
});

test('formatting and thresholds', () => {
  assert.equal(baseUrl('host:11434/'), 'http://host:11434');
  assert.equal(fmtBytes(21.5 * 1024 ** 3), '22 GB');
  assert.equal(fmtBytes(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(fmtCtx(131072), '128k');
  const s = demoData(0).servers[1]!;
  const th = { waitingAlert: 3, kvAlert: 90 };
  assert.equal(congested(s, th), false);
  assert.equal(congested({ ...s, waiting: 2 }, th), false);
  assert.equal(congested({ ...s, waiting: 3 }, th), true, 'red from waitingAlert on');
  assert.equal(congested({ ...s, kvUsage: 0.9 }, th), true, 'red from kvAlert on');
  assert.equal(congested({ ...s, reachable: false, waiting: 9 }, th), false);
});

test('servers filter: by name or address, with exclusions; per-widget lists', () => {
  const d = demoData(0);
  assert.deepEqual(serversOf(d, []).map((s) => s.name), ['ollama', 'vllm', 'llama.cpp', 'lm-studio']);
  assert.deepEqual(serversOf(d, ['vllm', 'llama*']).map((s) => s.name), ['vllm', 'llama.cpp']);
  assert.deepEqual(serversOf(d, ['!ollama', '!lm-*']).map((s) => s.name), ['vllm', 'llama.cpp']);
  assert.deepEqual(serversOf(d, '*192.168.1.41*').map((s) => s.name), ['vllm'], 'by address');
  assert.deepEqual(rateServers(d, { servers: [], onlyWithRate: true }).map((s) => s.name), ['vllm', 'llama.cpp', 'lm-studio'], 'Ollama gives no rate; down servers stay');
  assert.deepEqual(queueServers(d, { servers: ['!lm-studio'], onlyWithQueue: true }).map((s) => s.name), ['vllm', 'llama.cpp']);
  assert.deepEqual(modelRows(d, ['ollama']).map((r) => r.m.name), ['qwen2.5-coder:32b', 'nomic-embed-text:latest']);
});

test('source: Kiosko owns the timeout; each server gets most of it', () => {
  const src = plugin.sources![0]!;
  const props = (src.options as { props: Record<string, unknown> }).props;
  assert.equal('timeoutMs' in props, false, 'no option of its own');
  assert.equal(src.timeoutMs, 2500);
  assert.equal(serverBudget(2500), 2000);
  assert.equal(serverBudget(100), 200);
});

test('plugin: every widget renders its demo and with no servers; idle and urgent', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const { THEMES } = await import('@kiosko/sdk');
  const kit = await import('@loksly/lcd-canvas-kit');
  assert.equal(plugin.id, 'llm');
  assert.deepEqual(plugin.widgets!.map((w) => w.id), ['throughput', 'models', 'queue', 'status']);
  const src = plugin.sources![0]!;
  assert.equal(src.intervalMs, 5000);
  const ep = (src.options as { props: { endpoints: { default: unknown; item: { props: Record<string, { secret?: boolean }> } } } }).props.endpoints;
  assert.deepEqual(ep.default, [{ name: 'ollama', kind: 'ollama', url: 'http://127.0.0.1:11434', token: '' }]);
  assert.equal(ep.item.props.token!.secret, true);
  const now = Date.parse('2026-11-09T10:00:00Z');
  const theme = THEMES[0]!;
  const quiet = { at: now, servers: demoData(now).servers.map((s) => ({ ...s, genTps: s.genTps === undefined ? undefined : 0, running: s.running === undefined ? undefined : 0 })) };
  for (const w of plugin.widgets!) {
    const options = Object.fromEntries(Object.entries((w.options as { props: Record<string, { default: unknown }> }).props).map(([k, f]) => [k, f.default]));
    const demo = w.demo!({ options, now, locale: 'es' });
    assert.ok(demo.sources?.['llm/servers'], w.id);
    for (const [sw, sh] of [[1920, 462], [480, 480], [320, 240], [160, 90]] as const) {
      for (const sources of [demo.sources!, { 'llm/servers': { at: now, servers: [] } }, { 'llm/servers': quiet }]) {
        const g = createCanvas(sw, sh).getContext('2d');
        w.render(g as never, { options, data: undefined, sources, now, working: true, box: { x: 4, y: 4, w: sw - 8, h: sh - 8 }, theme, fonts: theme.fonts, kit, canvas: { createCanvas }, preview: true, locale: 'es', t: (x: { es: string }) => x.es, log: () => {}, dataDir: '' } as never);
      }
    }
    const st = (sources: Record<string, unknown>) => ({ options, data: undefined, sources, now, working: true }) as never;
    assert.equal(w.idle!(st(demo.sources!)), false, `${w.id}: vLLM is generating in the demo`);
    assert.equal(w.idle!(st({ 'llm/servers': quiet })), true, `${w.id}: idle when nothing generates`);
  }
  const q = plugin.widgets!.find((w) => w.id === 'queue')!;
  const qo = { waitingAlert: 3, kvAlert: 90, onlyWithQueue: true, servers: [], rows: 0 };
  const hot = { at: now, servers: [{ ...demoData(now).servers[1]!, waiting: 7 }] };
  const qs = (options: object, sources: Record<string, unknown>) => ({ options, data: undefined, sources, now, working: true }) as never;
  assert.equal(q.urgent!(qs(qo, { 'llm/servers': hot })), true);
  assert.equal(q.urgent!(qs({ ...qo, servers: ['!vllm'] }, { 'llm/servers': hot })), false, 'only its own servers count');
  assert.equal(q.urgent!(qs(qo, { 'llm/servers': demoData(now) })), false);
  assert.equal('takeOver' in (q.options as { props: object }).props, false, 'takeOver is the instance switch');
  assert.notEqual(q.takeOver, false, 'keeps the tile by default');
});

test('lists: empty, rows and "+N more"', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const { THEMES, createBaseContext } = await import('@kiosko/sdk');
  const kit = await import('@loksly/lcd-canvas-kit');
  const now = Date.parse('2026-11-09T10:00:00Z');
  const theme = THEMES[0]!;
  const byId = (id: string) => plugin.widgets!.find((w) => w.id === id)!;
  const defaults = (id: string) => Object.fromEntries(Object.entries((byId(id).options as { props: Record<string, { default: unknown }> }).props).map(([k, f]) => [k, f.default]));
  const paint = (id: string, options: Record<string, unknown>, sources: Record<string, unknown>, h = 100) => {
    const texts: string[] = [];
    const spy = { ...kit, drawTracked: (g: never, text: string, ...rest: never[]) => (texts.push(text), (kit.drawTracked as (...a: unknown[]) => number)(g, text, ...rest)) };
    const g = createCanvas(400, h + 8).getContext('2d');
    byId(id).render(g as never, { ...createBaseContext({ now, locale: 'en' }), options: { ...defaults(id), ...options }, data: undefined, sources, working: true, box: { x: 4, y: 4, w: 392, h }, theme, fonts: theme.fonts, kit: spy, canvas: { createCanvas }, preview: true } as never);
    return texts;
  };
  const demoSrc = { 'llm/servers': demoData(now) };
  // Four models, two rows asked for: two rows and "+2 more" under them.
  assert.ok(paint('models', { rows: 2 }, demoSrc).includes('+2 more'));
  assert.ok(!paint('models', { rows: 0 }, demoSrc, 400).some((x) => x.startsWith('+')), 'all fit');
  assert.ok(paint('models', { layout: 'one-line' }, demoSrc, 60).includes('+2 more'), 'one-line rows of 18–44 px');
  assert.ok(paint('status', { rows: 4 }, demoSrc, 60).some((x) => /^\+\d+ more$/.test(x)), 'status no longer cuts silently');
  assert.ok(paint('queue', {}, { 'llm/servers': { at: now, servers: [1, 2, 3, 4].map((i) => ({ ...demoData(now).servers[1]!, name: `v${i}` })) } }, 80).includes('+2 more'), 'queue no longer cuts silently');
  assert.ok(paint('models', { servers: ['nope'] }, demoSrc).includes('No server matches the filter'));
  const st = (id: string, sources: Record<string, unknown>, options: object = {}) => byId(id).empty!({ options: { ...defaults(id), ...options }, data: undefined, sources, now, working: true } as never);
  for (const id of ['throughput', 'models', 'queue', 'status']) {
    assert.equal(st(id, demoSrc), false, id);
    assert.equal(st(id, { 'llm/servers': { at: now, servers: [] } }), true, id);
    assert.equal(st(id, {}), false, `${id}: unknown until the first read`);
  }
  assert.equal(st('models', demoSrc, { servers: ['lm-studio'] }), true, 'a server with no models');
});
