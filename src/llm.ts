/**
 * Local LLM inference servers, polled over HTTP: Ollama, llama.cpp's
 * server, vLLM, TGI and anything OpenAI-compatible (LM Studio…). Each back
 * end reports what it exposes and nothing more; counters become rates
 * between two polls, so the reader keeps a small state per endpoint.
 */
import { bucketDelta, buckets, counterRate, label, parseProm, quantile, sum, type Metrics } from './prom.ts';

export const KINDS = ['ollama', 'llamacpp', 'vllm', 'openai', 'tgi'] as const;
export type Kind = (typeof KINDS)[number];

export interface Endpoint {
  name: string;
  kind: Kind;
  url: string;
  token?: string;
}

export interface LoadedModel {
  name: string;
  /** Bytes in memory (RAM + VRAM). */
  sizeBytes?: number;
  vramBytes?: number;
  contextLength?: number;
  /** When Ollama unloads it (keep-alive), ISO. */
  expiresAt?: string;
  quantization?: string;
  parameters?: string;
}

export interface Slot {
  id: number;
  busy: boolean;
  nCtx?: number;
  /** Tokens decoded so far in the current request. */
  decoded?: number;
}

export interface ServerStatus {
  name: string;
  kind: Kind;
  url: string;
  reachable: boolean;
  error?: string;
  version?: string;
  models: LoadedModel[];
  /** Models installed (Ollama /api/tags), loaded or not. */
  installed?: number;
  slots?: Slot[];
  running?: number;
  waiting?: number;
  /** Generation tokens per second. */
  genTps?: number;
  promptTps?: number;
  /** KV cache in use, 0‥1. */
  kvUsage?: number;
  /** Time to first token over the poll window, seconds. */
  ttftP50?: number;
  ttftP95?: number;
  promptTokensTotal?: number;
  genTokensTotal?: number;
  requestsTotal?: number;
  /** Recent generation tok/s: [time ms, value]. */
  history: [number, number][];
}

export interface LlmData {
  at: number;
  servers: ServerStatus[];
}

export const DEFAULT_ENDPOINTS: (Endpoint & { token: string })[] = [{ name: 'ollama', kind: 'ollama', url: 'http://127.0.0.1:11434', token: '' }];
/** How much history is kept per server. */
export const HISTORY_MS = 30 * 60_000;

interface Prev { at: number; prompt?: number; gen?: number; ttft?: [number, number][] }
export interface PollState { prev: Map<string, Prev>; history: Map<string, [number, number][]> }
export const createState = (): PollState => ({ prev: new Map(), history: new Map() });

export type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ReadOptions {
  fetch?: Fetch;
  now?: number;
  state?: PollState;
  /** How long one server may take, all its requests together. Default 2 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, path: string) { super(`HTTP ${status} on ${path}`); this.status = status; }
}

type Get = (path: string) => Promise<string>;
/** Optional endpoints: missing (404/501/503…) → undefined; network errors still throw. */
const maybe = async (get: Get, path: string): Promise<string | undefined> => {
  try { return await get(path); } catch (e) { if (e instanceof HttpError) return undefined; throw e; }
};
const json = <T>(s: string | undefined): T | undefined => {
  if (s === undefined) return undefined;
  try { return JSON.parse(s) as T; } catch { return undefined; }
};

/** What a back end read; the reader turns counters into rates. */
interface Reading extends Partial<Omit<ServerStatus, 'name' | 'kind' | 'url' | 'reachable' | 'history'>> {
  models: LoadedModel[];
  /** Counters for rates. */
  promptCounter?: number;
  genCounter?: number;
  ttftBuckets?: [number, number][];
  /** Gauges to fall back on with no previous reading. */
  genGauge?: number;
  promptGauge?: number;
}

interface OllamaPs { models?: { name: string; model?: string; size?: number; size_vram?: number; expires_at?: string; context_length?: number; details?: { parameter_size?: string; quantization_level?: string } }[] }

export async function readOllama(get: Get): Promise<Reading> {
  const version = json<{ version?: string }>(await get('/api/version'))?.version;
  const ps = json<OllamaPs>(await maybe(get, '/api/ps'));
  const tags = json<{ models?: unknown[] }>(await maybe(get, '/api/tags'));
  return {
    ...(version ? { version } : {}),
    ...(tags?.models ? { installed: tags.models.length } : {}),
    models: (ps?.models ?? []).map((m) => ({
      name: m.name || m.model || '?',
      ...(m.size !== undefined ? { sizeBytes: m.size } : {}),
      ...(m.size_vram !== undefined ? { vramBytes: m.size_vram } : {}),
      ...(m.context_length ? { contextLength: m.context_length } : {}),
      ...(m.expires_at ? { expiresAt: m.expires_at } : {}),
      ...(m.details?.quantization_level ? { quantization: m.details.quantization_level } : {}),
      ...(m.details?.parameter_size ? { parameters: m.details.parameter_size } : {}),
    })),
  };
}

interface LlamaSlot { id: number; n_ctx?: number; is_processing?: boolean; state?: number; next_token?: { n_decoded?: number }[] | { n_decoded?: number }; n_decoded?: number }
interface LlamaProps { model_path?: string; total_slots?: number; build_info?: string; default_generation_settings?: { n_ctx?: number; model?: string } }

const basename = (p: string) => p.split(/[\\/]/).pop()!.replace(/\.gguf$/i, '');

export async function readLlamaCpp(get: Get): Promise<Reading> {
  await get('/health'); // 503 while loading → reported as unreachable-with-reason
  const props = json<LlamaProps>(await maybe(get, '/props'));
  const slotsRaw = json<LlamaSlot[]>(await maybe(get, '/slots'));
  const metricsText = await maybe(get, '/metrics');
  const ms = metricsText ? parseProm(metricsText) : undefined;
  const slots: Slot[] | undefined = Array.isArray(slotsRaw) ? slotsRaw.map((s) => {
    const nt = Array.isArray(s.next_token) ? s.next_token[0] : s.next_token;
    const decoded = nt?.n_decoded ?? s.n_decoded;
    return { id: s.id, busy: s.is_processing ?? s.state === 1, ...(s.n_ctx ? { nCtx: s.n_ctx } : {}), ...(decoded !== undefined ? { decoded } : {}) };
  }) : undefined;
  let modelName = props?.model_path ? basename(props.model_path) : props?.default_generation_settings?.model ? basename(props.default_generation_settings.model) : undefined;
  if (!modelName) modelName = json<{ data?: { id: string }[] }>(await maybe(get, '/v1/models'))?.data?.[0]?.id;
  const nCtx = props?.default_generation_settings?.n_ctx ?? slots?.[0]?.nCtx;
  const r: Reading = {
    models: modelName ? [{ name: modelName, ...(nCtx ? { contextLength: nCtx } : {}) }] : [],
    ...(props?.build_info ? { version: props.build_info } : {}),
    ...(slots ? { slots, running: slots.filter((s) => s.busy).length } : {}),
  };
  if (ms) {
    const running = sum(ms, 'llamacpp:requests_processing');
    const waiting = sum(ms, 'llamacpp:requests_deferred');
    const kv = sum(ms, 'llamacpp:kv_cache_usage_ratio');
    if (running !== undefined) r.running = running;
    if (waiting !== undefined) r.waiting = waiting;
    if (kv !== undefined) r.kvUsage = kv;
    const p = sum(ms, 'llamacpp:prompt_tokens_total'), g = sum(ms, 'llamacpp:tokens_predicted_total');
    if (p !== undefined) { r.promptCounter = p; r.promptTokensTotal = p; }
    if (g !== undefined) { r.genCounter = g; r.genTokensTotal = g; }
    // Throughput gauges are averages of the last requests: only meaningful while something runs.
    const busy = (r.running ?? 0) > 0;
    r.genGauge = busy ? sum(ms, 'llamacpp:predicted_tokens_seconds') ?? 0 : 0;
    r.promptGauge = busy ? sum(ms, 'llamacpp:prompt_tokens_seconds') ?? 0 : 0;
  }
  return r;
}

export function vllmFromMetrics(ms: Metrics): Reading {
  const r: Reading = { models: [] };
  const running = sum(ms, 'vllm:num_requests_running');
  const waiting = sum(ms, 'vllm:num_requests_waiting');
  const kv = sum(ms, 'vllm:kv_cache_usage_perc', 'vllm:gpu_cache_usage_perc');
  if (running !== undefined) r.running = running;
  if (waiting !== undefined) r.waiting = waiting;
  if (kv !== undefined) r.kvUsage = kv;
  const p = sum(ms, 'vllm:prompt_tokens_total'), g = sum(ms, 'vllm:generation_tokens_total'), req = sum(ms, 'vllm:request_success_total');
  if (p !== undefined) { r.promptCounter = p; r.promptTokensTotal = p; }
  if (g !== undefined) { r.genCounter = g; r.genTokensTotal = g; }
  if (req !== undefined) r.requestsTotal = req;
  const tb = buckets(ms, 'vllm:time_to_first_token_seconds');
  if (tb.length) r.ttftBuckets = tb;
  const model = label(ms, 'vllm:', 'model_name');
  if (model) r.models = [{ name: model }];
  return r;
}

export async function readVllm(get: Get): Promise<Reading> {
  const r = vllmFromMetrics(parseProm(await get('/metrics')));
  const models = json<{ data?: { id: string; max_model_len?: number }[] }>(await maybe(get, '/v1/models'))?.data;
  if (models?.length) r.models = models.map((m) => ({ name: m.id, ...(m.max_model_len ? { contextLength: m.max_model_len } : {}) }));
  const version = json<{ version?: string }>(await maybe(get, '/version'))?.version;
  if (version) r.version = version;
  return r;
}

export async function readTgi(get: Get): Promise<Reading> {
  const info = json<{ model_id?: string; version?: string; max_total_tokens?: number }>(await get('/info'));
  const text = await maybe(get, '/metrics');
  const r: Reading = { models: info?.model_id ? [{ name: info.model_id, ...(info.max_total_tokens ? { contextLength: info.max_total_tokens } : {}) }] : [], ...(info?.version ? { version: info.version } : {}) };
  if (text) {
    const ms = parseProm(text);
    const running = sum(ms, 'tgi_batch_current_size'), waiting = sum(ms, 'tgi_queue_size');
    if (running !== undefined) r.running = running;
    if (waiting !== undefined) r.waiting = waiting;
    const g = sum(ms, 'tgi_request_generated_tokens_sum'), p = sum(ms, 'tgi_request_input_length_sum'), req = sum(ms, 'tgi_request_success');
    if (g !== undefined) { r.genCounter = g; r.genTokensTotal = g; }
    if (p !== undefined) { r.promptCounter = p; r.promptTokensTotal = p; }
    if (req !== undefined) r.requestsTotal = req;
  }
  return r;
}

export async function readOpenAi(get: Get): Promise<Reading> {
  const d = json<{ data?: { id: string }[] }>(await get('/v1/models'));
  return { models: (d?.data ?? []).map((m) => ({ name: m.id })) };
}

const READERS: Record<Kind, (get: Get) => Promise<Reading>> = { ollama: readOllama, llamacpp: readLlamaCpp, vllm: readVllm, tgi: readTgi, openai: readOpenAi };

const keyOf = (e: Endpoint) => `${e.kind} ${e.url}`;
export const baseUrl = (u: string) => (/^https?:\/\//.test(u.trim()) ? u.trim() : `http://${u.trim()}`).replace(/\/+$/, '').replace(/\/v1$/, '');

const errorText = (e: unknown): string => {
  if (e instanceof HttpError) return e.message;
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  return err?.cause?.code ?? err?.message ?? String(e);
};

export async function readServer(ep: Endpoint, o: Required<Omit<ReadOptions, 'signal'>> & { signal?: AbortSignal }): Promise<ServerStatus> {
  const base = baseUrl(ep.url);
  const headers: Record<string, string> = { Accept: 'application/json, text/plain' };
  if (ep.token?.trim()) headers.Authorization = `Bearer ${ep.token.trim()}`;
  // One deadline for all the requests of this server: a slow one is reported down, the others still count.
  const deadline = AbortSignal.timeout(o.timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, deadline]) : deadline;
  const get: Get = async (path) => {
    const res = await o.fetch(`${base}${path}`, { headers, signal });
    if (!res.ok) throw new HttpError(res.status, path);
    return res.text();
  };
  const key = keyOf(ep);
  const history = o.state.history.get(key) ?? [];
  const id = { name: ep.name || ep.kind, kind: ep.kind, url: base };
  let r: Reading;
  try {
    r = await READERS[ep.kind](get);
  } catch (e) {
    o.state.prev.delete(key);
    return { ...id, reachable: false, error: errorText(e), models: [], history: history.filter(([t]) => t > o.now - HISTORY_MS) };
  }
  const prev = o.state.prev.get(key);
  const dt = prev ? o.now - prev.at : 0;
  const genTps = counterRate(prev?.gen, r.genCounter, dt) ?? r.genGauge;
  const promptTps = counterRate(prev?.prompt, r.promptCounter, dt) ?? r.promptGauge;
  const window = r.ttftBuckets ? bucketDelta(prev?.ttft, r.ttftBuckets) : [];
  const p50 = quantile(0.5, window), p95 = quantile(0.95, window);
  o.state.prev.set(key, { at: o.now, ...(r.promptCounter !== undefined ? { prompt: r.promptCounter } : {}), ...(r.genCounter !== undefined ? { gen: r.genCounter } : {}), ...(r.ttftBuckets ? { ttft: r.ttftBuckets } : {}) });
  const next = genTps !== undefined ? [...history, [o.now, genTps] as [number, number]] : history;
  const kept = next.filter(([t]) => t > o.now - HISTORY_MS);
  o.state.history.set(key, kept);
  const { promptCounter: _p, genCounter: _g, ttftBuckets: _t, genGauge: _gg, promptGauge: _pg, ...rest } = r;
  return {
    ...id, reachable: true, ...rest,
    ...(genTps !== undefined ? { genTps } : {}),
    ...(promptTps !== undefined ? { promptTps } : {}),
    ...(p50 !== undefined ? { ttftP50: p50 } : {}),
    ...(p95 !== undefined ? { ttftP95: p95 } : {}),
    history: kept,
  };
}

const sharedState = createState();

/** Every endpoint in parallel; a dead one only costs its own timeout. */
export async function readServers(endpoints: Endpoint[], o: ReadOptions = {}): Promise<LlmData> {
  const now = o.now ?? Date.now();
  const opts = { fetch: o.fetch ?? (globalThis.fetch as unknown as Fetch), now, state: o.state ?? sharedState, timeoutMs: o.timeoutMs ?? 2000, ...(o.signal ? { signal: o.signal } : {}) };
  const list = endpoints.filter((e) => e.url?.trim());
  return { at: now, servers: await Promise.all(list.map((e) => readServer(e, opts))) };
}

/* ---------- helpers for the widgets ---------- */

/** Something is being generated (or queued) right now. */
export const busy = (s: ServerStatus) => s.reachable && ((s.genTps ?? 0) > 0.5 || (s.running ?? 0) > 0 || (s.waiting ?? 0) > 0);

export function fmtBytes(b: number | undefined): string {
  if (b === undefined) return '';
  const g = b / 1024 ** 3;
  return g >= 10 ? `${Math.round(g)} GB` : g >= 1 ? `${g.toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
}

export function fmtCtx(n: number | undefined): string {
  if (!n) return '';
  return n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
}

export function fmtTps(v: number | undefined): string {
  if (v === undefined) return '–';
  return v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(0) : v.toFixed(1);
}

/** Keep-alive countdown: "4:59", "12 min", "∞" (Ollama gives a far-future date for keep_alive -1). */
export function countdown(expiresAt: string | undefined, now: number): string {
  if (!expiresAt) return '';
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms)) return '';
  if (ms > 365 * 86_400_000) return '∞';
  if (ms <= 0) return '0:00';
  const s = Math.round(ms / 1000);
  if (s < 600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

/* ---------- demo ---------- */

const GB = 1024 ** 3;

export function demoData(now: number): LlmData {
  const wave = (n: number, base: number, amp: number, seed: number): [number, number][] =>
    Array.from({ length: n }, (_, i) => [now - (n - 1 - i) * 5000, Math.max(0, base + amp * Math.sin((i + seed) / 7) + amp * 0.4 * Math.sin((i * 3 + seed) / 5))]);
  const vllmHist = wave(120, 70, 18, 3);
  vllmHist[vllmHist.length - 1]![1] = 85;
  const llamaHist = wave(120, 0, 0, 0).map(([t], i): [number, number] => [t, i > 60 && i < 95 ? 38 + 6 * Math.sin(i / 3) : 0]);
  return {
    at: now,
    servers: [
      {
        name: 'ollama', kind: 'ollama', url: 'http://192.168.1.40:11434', reachable: true, version: '0.12.6', installed: 9,
        models: [
          { name: 'qwen2.5-coder:32b', sizeBytes: 21.5 * GB, vramBytes: 21.5 * GB, contextLength: 32768, expiresAt: new Date(now + 4 * 60_000 + 12_000).toISOString(), quantization: 'Q4_K_M', parameters: '32.8B' },
          { name: 'nomic-embed-text:latest', sizeBytes: 0.6 * GB, vramBytes: 0.6 * GB, contextLength: 8192, expiresAt: new Date(now + 23 * 60_000).toISOString(), quantization: 'F16', parameters: '137M' },
        ],
        history: [],
      },
      {
        name: 'vllm', kind: 'vllm', url: 'http://192.168.1.41:8000', reachable: true, version: '0.11.0',
        models: [{ name: 'meta-llama/Llama-3.1-8B-Instruct', contextLength: 131072 }],
        running: 3, waiting: 0, genTps: 85, promptTps: 412, kvUsage: 0.37, ttftP50: 0.18, ttftP95: 0.62,
        promptTokensTotal: 4_812_330, genTokensTotal: 1_204_871, requestsTotal: 9_312, history: vllmHist,
      },
      {
        name: 'llama.cpp', kind: 'llamacpp', url: 'http://192.168.1.42:8080', reachable: true, version: 'b6710',
        models: [{ name: 'gemma-3-27b-it-Q4_K_M', contextLength: 16384 }],
        slots: [{ id: 0, busy: false, nCtx: 8192 }, { id: 1, busy: false, nCtx: 8192 }], running: 0, waiting: 0, genTps: 0, promptTps: 0, kvUsage: 0.08,
        history: llamaHist,
      },
      { name: 'lm-studio', kind: 'openai', url: 'http://192.168.1.43:1234', reachable: false, error: 'ECONNREFUSED', models: [], history: [] },
    ],
  };
}
