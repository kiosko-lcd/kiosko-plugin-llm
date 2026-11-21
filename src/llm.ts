/**
 * Local LLM inference servers, polled over HTTP: Ollama, llama.cpp's
 * server, vLLM, TGI and anything OpenAI-compatible (LM Studio…). Each back
 * end reports what it exposes and nothing more; counters become rates
 * between two polls, so the reader keeps a small state per endpoint.
 */
import type { Formatters } from '@kiosko/sdk';
import { HistWindow, buckets, counterRate, label, parseProm, percentile, sum, type Metrics } from './prom.ts';
import { proxyAt, type ProxySnapshot, type ProxySpeed } from './proxy.ts';

export const KINDS = ['ollama', 'llamacpp', 'vllm', 'openai', 'tgi'] as const;
export type Kind = (typeof KINDS)[number];

export interface Endpoint {
  name: string;
  kind: Kind;
  url: string;
  token?: string;
  /** Measuring proxy in front of this server: the port it listens on, 0 = off. */
  proxyPort?: number;
  /** Where the proxy listens: 127.0.0.1 unless the user says otherwise. */
  proxyHost?: string;
}

/** The speed of one model, where the server (or the proxy) tells them apart. */
export interface ModelSpeed {
  model: string;
  genTps?: number;
  promptTps?: number;
  decodeTps?: number;
  lowTps?: number;
  ttftP50?: number;
  ttftP90?: number;
  history: [number, number][];
}

/** The measuring proxy, as the widgets see it. */
export interface ProxyStatus {
  listen: string;
  listening: boolean;
  error?: string;
  active: number;
  requests: number;
  /** Some recent figure is the proxy's own count (one token per chunk). */
  estimated: boolean;
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
  /** Time to first token over the last minutes, seconds. */
  ttftP50?: number;
  ttftP90?: number;
  ttftP95?: number;
  /** Time per output token of one answer over the last minutes, seconds (vLLM, TGI). */
  tpotP50?: number;
  tpotP90?: number;
  /** Decode speed of one answer, typical: what one user sees, batching aside. */
  decodeTps?: number;
  /**
   * The "1 % low" of generation: the slow end of the recent answers' decode
   * speed (1 / p90 of the time per output token; p10 of the answers' speed).
   */
  lowTps?: number;
  /** Where the speed figures came from. */
  measured?: 'server' | 'proxy';
  proxy?: ProxyStatus;
  /** Per model, where they can be told apart (the proxy). */
  speeds?: ModelSpeed[];
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

export const DEFAULT_ENDPOINTS: (Endpoint & { token: string; proxyPort: number; proxyHost: string })[] = [{ name: 'ollama', kind: 'ollama', url: 'http://127.0.0.1:11434', token: '', proxyPort: 0, proxyHost: '127.0.0.1' }];
/** How much history is kept per server. */
export const HISTORY_MS = 30 * 60_000;
/** The answers the TTFT and the low describe: the last few minutes'. */
export const RECENT_MS = 5 * 60_000;
/** Fewer tokens than this in a poll say little about the decode speed. */
const MIN_DECODE_TOKENS = 8;

interface Prev { at: number; prompt?: number; gen?: number; decodeSeconds?: number }
export interface PollState {
  prev: Map<string, Prev>;
  history: Map<string, [number, number][]>;
  ttft: Map<string, HistWindow>;
  tpot: Map<string, HistWindow>;
  /** llama.cpp: decode speed of each poll that decoded something, [time, tok/s]. */
  decode: Map<string, [number, number][]>;
}
export const createState = (): PollState => ({ prev: new Map(), history: new Map(), ttft: new Map(), tpot: new Map(), decode: new Map() });

/** What the reader needs of a proxy: its log and whether it listens. */
export interface ProxyView {
  listen: string;
  listening: boolean;
  error?: string | undefined;
  log: { snapshot(now: number, windowMs: number): Omit<ProxySnapshot, 'listen' | 'listening' | 'error'> };
}

export type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ReadOptions {
  fetch?: Fetch;
  now?: number;
  state?: PollState;
  /** How long one server may take, all its requests together. Default 2 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The proxy of an endpoint (default: the one the source started). */
  proxyOf?: (ep: Endpoint) => ProxyView | undefined;
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
  /** Seconds spent decoding, a counter (llama.cpp). */
  decodeSecondsCounter?: number;
  ttftBuckets?: [number, number][];
  tpotBuckets?: [number, number][];
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
    const ds = sum(ms, 'llamacpp:tokens_predicted_seconds_total');
    if (ds !== undefined) r.decodeSecondsCounter = ds;
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
  // Per answer first; older vLLMs name it time_per_output_token; inter-token latency (per token) last.
  const pb = firstBuckets(ms, 'vllm:request_time_per_output_token_seconds', 'vllm:time_per_output_token_seconds', 'vllm:inter_token_latency_seconds');
  if (pb.length) r.tpotBuckets = pb;
  const model = label(ms, 'vllm:', 'model_name');
  if (model) r.models = [{ name: model }];
  return r;
}

/** The buckets of the first of these histogram families the server exposes. */
function firstBuckets(ms: Metrics, ...families: string[]): [number, number][] {
  for (const f of families) {
    const b = buckets(ms, f);
    if (b.length) return b;
  }
  return [];
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
    const pb = buckets(ms, 'tgi_request_mean_time_per_token_duration');
    if (pb.length) r.tpotBuckets = pb;
  }
  return r;
}

interface LmsV1Models { models?: { type?: string; key?: string; loaded_instances?: { id?: string; config?: { context_length?: number } }[] }[] }
interface LmsV0Models { data?: { id: string; type?: string; state?: string; max_context_length?: number }[] }

/**
 * Any OpenAI-compatible server: its model list. LM Studio also says which
 * models are loaded (REST API v1 `/api/v1/models`, or v0 `/api/v0/models`):
 * then those are the models shown.
 */
export async function readOpenAi(get: Get): Promise<Reading> {
  const d = json<{ data?: { id: string }[] }>(await get('/v1/models'));
  const listed = (d?.data ?? []).map((m) => ({ name: m.id }));
  const v1 = json<LmsV1Models>(await maybe(get, '/api/v1/models'));
  if (Array.isArray(v1?.models) && v1.models.some((m) => Array.isArray(m.loaded_instances))) {
    const loaded = v1.models.flatMap((m) => (m.loaded_instances ?? []).map((i) => ({ name: i.id || m.key || '?', ...(i.config?.context_length ? { contextLength: i.config.context_length } : {}) })));
    return { models: loaded, installed: v1.models.length };
  }
  const v0 = json<LmsV0Models>(await maybe(get, '/api/v0/models'));
  if (Array.isArray(v0?.data) && v0.data.some((m) => typeof m.state === 'string')) {
    const loaded = v0.data.filter((m) => m.state === 'loaded').map((m) => ({ name: m.id, ...(m.max_context_length ? { contextLength: m.max_context_length } : {}) }));
    return { models: loaded, installed: v0.data.length };
  }
  return { models: listed };
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
  const prev = o.state.prev.get(key);
  const dt = prev ? o.now - prev.at : 0;
  const px = proxyFigures(ep, o, key, dt);
  let r: Reading;
  try {
    r = await READERS[ep.kind](get);
  } catch (e) {
    o.state.prev.delete(key);
    return { ...id, reachable: false, error: errorText(e), models: [], history: history.filter(([t]) => t > o.now - HISTORY_MS), ...(px ? { proxy: px.status } : {}) };
  }
  const own = serverFigures(r, prev, dt, o, key);
  o.state.prev.set(key, { at: o.now, ...(r.promptCounter !== undefined ? { prompt: r.promptCounter } : {}), ...(r.genCounter !== undefined ? { gen: r.genCounter } : {}), ...(r.decodeSecondsCounter !== undefined ? { decodeSeconds: r.decodeSecondsCounter } : {}) });
  // The server's own figures first; the proxy's fill what it doesn't say.
  const speed: Partial<ServerStatus> = { ...(px?.speed ?? {}), ...own };
  const measured = own.genTps !== undefined ? 'server' : px?.speed.genTps !== undefined ? 'proxy' : undefined;
  const genTps = speed.genTps;
  const next = genTps !== undefined ? [...history, [o.now, genTps] as [number, number]] : history;
  const kept = next.filter(([t]) => t > o.now - HISTORY_MS);
  o.state.history.set(key, kept);
  const { promptCounter: _p, genCounter: _g, decodeSecondsCounter: _d, ttftBuckets: _t, tpotBuckets: _tp, genGauge: _gg, promptGauge: _pg, ...rest } = r;
  return {
    ...id, reachable: true, ...rest,
    ...speed,
    ...(measured ? { measured } : {}),
    ...(px ? { proxy: px.status } : {}),
    ...(px?.speeds.length ? { speeds: px.speeds } : {}),
    history: kept,
  };
}

const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Rates from counters, quantiles from the histograms' last minutes, the low. */
function serverFigures(r: Reading, prev: Prev | undefined, dt: number, o: { now: number; state: PollState }, key: string): Partial<ServerStatus> {
  const genTps = counterRate(prev?.gen, r.genCounter, dt) ?? r.genGauge;
  const promptTps = counterRate(prev?.prompt, r.promptCounter, dt) ?? r.promptGauge;
  const out: Partial<ServerStatus> = defined({ genTps, promptTps });
  const win = (m: Map<string, HistWindow>, bs: [number, number][] | undefined) => {
    if (!bs) return undefined;
    let w = m.get(key);
    if (!w) m.set(key, (w = new HistWindow(RECENT_MS)));
    w.push(o.now, bs);
    return w.count() > 0 ? w : undefined;
  };
  const tt = win(o.state.ttft, r.ttftBuckets);
  if (tt) Object.assign(out, defined({ ttftP50: tt.quantile(0.5), ttftP90: tt.quantile(0.9), ttftP95: tt.quantile(0.95) }));
  const tp = win(o.state.tpot, r.tpotBuckets);
  if (tp) {
    const p50 = tp.quantile(0.5), p90 = tp.quantile(0.9);
    Object.assign(out, defined({ tpotP50: p50, tpotP90: p90, decodeTps: p50 ? 1 / p50 : undefined, lowTps: p90 ? 1 / p90 : undefined }));
  }
  // llama.cpp: tokens over the seconds spent decoding them, poll by poll; the low is the slow tenth of those.
  if (r.decodeSecondsCounter !== undefined && r.genCounter !== undefined && prev?.decodeSeconds !== undefined && prev.gen !== undefined) {
    const dTok = r.genCounter - prev.gen, dSec = r.decodeSecondsCounter - prev.decodeSeconds;
    const samples = (o.state.decode.get(key) ?? []).filter(([t]) => t > o.now - RECENT_MS);
    if (dTok >= MIN_DECODE_TOKENS && dSec > 0) samples.push([o.now, dTok / dSec]);
    o.state.decode.set(key, samples);
    const v = samples.map(([, x]) => x);
    Object.assign(out, defined({ decodeTps: percentile(0.5, v), lowTps: percentile(0.1, v) }));
  }
  return out;
}

/** The measuring proxy's figures for this endpoint, if it has one. */
function proxyFigures(ep: Endpoint, o: { now: number; state: PollState; proxyOf: (ep: Endpoint) => ProxyView | undefined }, key: string, dt: number): { status: ProxyStatus; speed: Partial<ServerStatus>; speeds: ModelSpeed[] } | undefined {
  if (!ep.proxyPort) return undefined;
  const p = o.proxyOf(ep);
  if (!p) return { status: { listen: proxyListen(ep), listening: false, error: 'not running', active: 0, requests: 0, estimated: false }, speed: {}, speeds: [] };
  // Rates over the time since the last read (the poll interval), within reason.
  const snap = p.log.snapshot(o.now, Math.min(60_000, Math.max(2_000, dt || 5_000)));
  const pick = (s: ProxySpeed): Partial<ServerStatus> => defined({ genTps: s.genTps, promptTps: s.promptTps, decodeTps: s.decodeTps, lowTps: s.lowTps, ttftP50: s.ttftP50, ttftP90: s.ttftP90 });
  const speeds = snap.models.map((m): ModelSpeed => {
    const hk = `${key}\u0000${m.model}`;
    const h = [...(o.state.history.get(hk) ?? []), [o.now, m.genTps] as [number, number]].filter(([t]) => t > o.now - HISTORY_MS);
    o.state.history.set(hk, h);
    return { model: m.model, ...pick(m), history: h };
  });
  return {
    status: { listen: p.listen, listening: p.listening, ...(p.error ? { error: p.error } : {}), active: snap.active, requests: snap.requests, estimated: snap.estimated },
    speed: pick(snap),
    speeds,
  };
}

/** host:port the proxy of an endpoint listens on. */
export const proxyListen = (ep: Endpoint) => {
  const h = ep.proxyHost?.trim() || '127.0.0.1';
  return `${h.includes(':') ? `[${h}]` : h}:${ep.proxyPort}`;
};

const sharedState = createState();
const defaultProxyOf = (ep: Endpoint): ProxyView | undefined => (ep.proxyPort ? proxyAt(ep.proxyHost?.trim() || '127.0.0.1', ep.proxyPort) : undefined);

/** Every endpoint in parallel; a dead one only costs its own timeout. */
export async function readServers(endpoints: Endpoint[], o: ReadOptions = {}): Promise<LlmData> {
  const now = o.now ?? Date.now();
  const opts = { fetch: o.fetch ?? (globalThis.fetch as unknown as Fetch), now, state: o.state ?? sharedState, timeoutMs: o.timeoutMs ?? 2000, proxyOf: o.proxyOf ?? defaultProxyOf, ...(o.signal ? { signal: o.signal } : {}) };
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

/**
 * Keep-alive countdown: "4:59", "12 min", "2 h" (in the user's language
 * through `fmt`: "12 分鐘"), "∞" (Ollama gives a far-future date for keep_alive -1).
 */
export function countdown(expiresAt: string | undefined, now: number, fmt?: Pick<Formatters, 'duration'>): string {
  if (!expiresAt) return '';
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms)) return '';
  if (ms > 365 * 86_400_000) return '∞';
  if (ms <= 0) return '0:00';
  const s = Math.round(ms / 1000);
  if (s < 600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const length = s < 5400 ? Math.round(s / 60) * 60_000 : Math.round(s / 3600) * 3_600_000;
  if (fmt) return fmt.duration(length, { compact: true });
  return s < 5400 ? `${length / 60_000} min` : `${length / 3_600_000} h`;
}

/* ---------- demo ---------- */

const GB = 1024 ** 3;

/**
 * The models people run at home, by where the user is: Claude and Gemini are
 * not offered in mainland China, so there (and in Taiwan) the open models
 * that lead locally, Qwen and DeepSeek's distills. Names are proper nouns: a
 * list per region, not a translation.
 */
function demoModels(now: number, locale: string) {
  const zh = /^zh\b/i.test(locale);
  const ttl = (ms: number) => new Date(now + ms).toISOString();
  return zh
    ? {
        ollama: [
          { name: 'qwen3:32b', sizeBytes: 20.2 * GB, vramBytes: 20.2 * GB, contextLength: 40960, expiresAt: ttl(4 * 60_000 + 12_000), quantization: 'Q4_K_M', parameters: '32.8B' },
          { name: 'deepseek-r1:14b', sizeBytes: 9 * GB, vramBytes: 9 * GB, contextLength: 32768, expiresAt: ttl(23 * 60_000), quantization: 'Q4_K_M', parameters: '14.8B' },
        ],
        vllm: [{ name: 'Qwen/Qwen3-30B-A3B', contextLength: 40960 }],
        llamacpp: [{ name: 'glm-4-9b-chat-Q4_K_M', contextLength: 16384 }],
      }
    : {
        ollama: [
          { name: 'qwen2.5-coder:32b', sizeBytes: 21.5 * GB, vramBytes: 21.5 * GB, contextLength: 32768, expiresAt: ttl(4 * 60_000 + 12_000), quantization: 'Q4_K_M', parameters: '32.8B' },
          { name: 'nomic-embed-text:latest', sizeBytes: 0.6 * GB, vramBytes: 0.6 * GB, contextLength: 8192, expiresAt: ttl(23 * 60_000), quantization: 'F16', parameters: '137M' },
        ],
        vllm: [{ name: 'meta-llama/Llama-3.1-8B-Instruct', contextLength: 131072 }],
        llamacpp: [{ name: 'gemma-3-27b-it-Q4_K_M', contextLength: 16384 }],
      };
}

export function demoData(now: number, locale = 'en'): LlmData {
  const models = demoModels(now, locale);
  const wave = (n: number, base: number, amp: number, seed: number): [number, number][] =>
    Array.from({ length: n }, (_, i) => [now - (n - 1 - i) * 5000, Math.max(0, base + amp * Math.sin((i + seed) / 7) + amp * 0.4 * Math.sin((i * 3 + seed) / 5))]);
  const vllmHist = wave(120, 70, 18, 3);
  vllmHist[vllmHist.length - 1]![1] = 85;
  const llamaHist = wave(120, 0, 0, 0).map(([t], i): [number, number] => [t, i > 60 && i < 95 ? 38 + 6 * Math.sin(i / 3) : 0]);
  // Ollama through the measuring proxy: answers with pauses between them, one slow stretch while a second model loaded.
  const ollamaHist = wave(120, 0, 0, 0).map(([t], i): [number, number] => {
    const on = i % 17 < 12 && i > 4;
    if (!on) return [t, 0];
    const slow = i > 70 && i < 76;
    return [t, slow ? 7 + (i % 3) : 41 + 5 * Math.sin(i / 2.3) + 2 * Math.sin(i * 1.7)];
  });
  ollamaHist[ollamaHist.length - 1]![1] = 43.6;
  const first = models.ollama[0]!.name;
  return {
    at: now,
    servers: [
      {
        name: 'ollama', kind: 'ollama', url: 'http://192.168.1.40:11434', reachable: true, version: '0.40.17', installed: 9,
        models: models.ollama,
        genTps: 43.6, promptTps: 980, decodeTps: 42.1, lowTps: 31.4, ttftP50: 0.34, ttftP90: 0.82, measured: 'proxy',
        proxy: { listen: '127.0.0.1:11435', listening: true, active: 1, requests: 214, estimated: false },
        speeds: [{ model: first, genTps: 43.6, promptTps: 980, decodeTps: 42.1, lowTps: 31.4, ttftP50: 0.34, ttftP90: 0.82, history: ollamaHist }],
        history: ollamaHist,
      },
      {
        name: 'vllm', kind: 'vllm', url: 'http://192.168.1.41:8000', reachable: true, version: '0.11.0',
        models: models.vllm,
        running: 3, waiting: 0, genTps: 85, promptTps: 412, kvUsage: 0.37, ttftP50: 0.18, ttftP90: 0.48, ttftP95: 0.62,
        tpotP50: 0.032, tpotP90: 0.045, decodeTps: 31.3, lowTps: 22.2, measured: 'server',
        promptTokensTotal: 4_812_330, genTokensTotal: 1_204_871, requestsTotal: 9_312, history: vllmHist,
      },
      {
        name: 'llama.cpp', kind: 'llamacpp', url: 'http://192.168.1.42:8080', reachable: true, version: 'b6710',
        models: models.llamacpp,
        slots: [{ id: 0, busy: false, nCtx: 8192 }, { id: 1, busy: false, nCtx: 8192 }], running: 0, waiting: 0, genTps: 0, promptTps: 0, kvUsage: 0.08,
        decodeTps: 39.2, lowTps: 33.5, measured: 'server',
        history: llamaHist,
      },
      { name: 'lm-studio', kind: 'openai', url: 'http://192.168.1.43:1234', reachable: false, error: 'ECONNREFUSED', models: [], history: [] },
    ],
  };
}
