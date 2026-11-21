/**
 * The measuring proxy: an optional local HTTP listener in front of a server
 * that keeps no speed figures of its own (Ollama, LM Studio). Clients talk to
 * it instead of the server; every request and response is piped through
 * unchanged, streaming included, and the answers of the inference routes are
 * read on the way for their counts and timings (see meter.ts). Nothing of a
 * request or an answer is stored or logged: only token counts, durations and
 * the model's name.
 */
import http from 'node:http';
import https from 'node:https';
import { percentile } from './prom.ts';
import { ResponseMeter, type RequestRecord } from './meter.ts';

/** The routes whose answers are measured; anything else is only piped. */
export const METERED = /^\/(api\/(generate|chat)|v1\/(chat\/completions|completions|responses|messages)|api\/v0\/(chat\/)?completions|api\/v1\/chat|completions?|chat\/completions)\/?$/;

/** How long figures are kept. */
export const KEEP_MS = 30 * 60_000;
/** The requests that make the TTFT and the low: the last few minutes'. */
export const RECENT_MS = 5 * 60_000;
const MAX_RECORDS = 5000;

/** The speed figures of one server (or one model of it) through the proxy. */
export interface ProxySpeed {
  /** Generation tokens per second, all requests together, over the window asked. */
  genTps: number;
  promptTps: number;
  /** Typical decode speed of one answer, and its slow end (p10 of the recent answers). */
  decodeTps?: number;
  lowTps?: number;
  ttftP50?: number;
  ttftP90?: number;
  /** Answers measured in the last minutes. */
  recent: number;
  /** Some figure of these answers is the proxy's count (one token per chunk), not the server's. */
  estimated: boolean;
}

export interface ProxySnapshot extends ProxySpeed {
  listen: string;
  listening: boolean;
  error?: string;
  /** Answers being generated now. */
  active: number;
  /** Answers measured since it started. */
  requests: number;
  models: (ProxySpeed & { model: string })[];
}

/** Tokens per second, by second, per model: `add` spreads a count over a span. */
class Ring {
  private by = new Map<string, Map<number, number>>();
  add(model: string, from: number, to: number, n: number): void {
    if (!(n > 0)) return;
    let m = this.by.get(model);
    if (!m) this.by.set(model, (m = new Map()));
    const a = Math.floor(from / 1000), b = Math.max(a, Math.floor(to / 1000));
    const each = n / (b - a + 1);
    for (let s = a; s <= b; s++) m.set(s, (m.get(s) ?? 0) + each);
  }
  /** Tokens counted in (now − ms, now]. */
  sum(model: string | undefined, now: number, ms: number): number {
    const from = Math.floor((now - ms) / 1000), to = Math.floor(now / 1000);
    let t = 0;
    for (const [k, m] of this.by) {
      if (model !== undefined && k !== model) continue;
      for (const [s, v] of m) if (s > from && s <= to) t += v;
    }
    return t;
  }
  prune(now: number): void {
    const keep = Math.floor((now - KEEP_MS) / 1000);
    for (const [k, m] of this.by) {
      for (const s of m.keys()) if (s < keep) m.delete(s);
      if (!m.size) this.by.delete(k);
    }
  }
  models(): string[] {
    return [...this.by.keys()];
  }
}

/** What the proxy saw: live token counts and the record of each answer. */
export class SpeedLog {
  private gen = new Ring();
  private prompt = new Ring();
  private records: RequestRecord[] = [];
  private live = new Set<ResponseMeter>();
  requests = 0;

  /** A response to follow. The meter counts its tokens live until `finish`. */
  begin(contentType: string | undefined, start: number): ResponseMeter {
    // Tokens seen before the model's name is known wait in the meter, then count under it.
    let pending: number[] = [];
    const meter: ResponseMeter = new ResponseMeter(contentType, start, {
      onToken: (model, at) => {
        if (!model) return void pending.push(at);
        for (const t of pending) this.gen.add(model, t, t, 1);
        pending = [];
        this.gen.add(model, at, at, 1);
      },
    });
    this.live.add(meter);
    const finish = meter.finish.bind(meter);
    meter.finish = (end, complete) => {
      this.live.delete(meter);
      const r = finish(end, complete);
      if (r) {
        for (const t of pending) this.gen.add(r.model, t, t, 1);
        this.record(r, meter.chunks);
      }
      return r;
    };
    return meter;
  }

  /** An answer is over: its exact figures replace the live count. */
  record(r: RequestRecord, counted: number): void {
    this.requests++;
    const genTokens = r.genTokens ?? 0;
    // The chunks counted live; the server's total may be more (several tokens per chunk) or all of it (not streamed).
    const extra = genTokens - counted;
    if (extra > 0) {
      const from = r.firstAt ?? (r.decodeTps ? r.end - (genTokens / r.decodeTps) * 1000 : r.end);
      this.gen.add(r.model, from, r.end, extra);
    }
    if (r.promptTokens) {
      const to = r.firstAt ?? (r.ttft !== undefined ? r.start + r.ttft * 1000 : r.end);
      const from = r.promptTps ? to - (r.promptTokens / r.promptTps) * 1000 : r.start;
      this.prompt.add(r.model, Math.max(r.start, from), to, r.promptTokens);
    }
    this.records.push(r);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
  }

  get active(): number {
    return this.live.size;
  }

  /** The figures over the last `windowMs` (rates) and the last minutes (TTFT, low). */
  snapshot(now: number, windowMs: number): Omit<ProxySnapshot, 'listen' | 'listening' | 'error'> {
    this.gen.prune(now);
    this.prompt.prune(now);
    this.records = this.records.filter((r) => r.end > now - KEEP_MS);
    const models = [...new Set([...this.gen.models(), ...this.records.map((r) => r.model)])].filter(Boolean).sort();
    return {
      ...this.speed(undefined, now, windowMs),
      active: this.live.size,
      requests: this.requests,
      models: models.map((model) => ({ model, ...this.speed(model, now, windowMs) })),
    };
  }

  private speed(model: string | undefined, now: number, windowMs: number): ProxySpeed {
    const w = Math.max(1000, windowMs);
    const recent = this.records.filter((r) => r.end > now - RECENT_MS && (model === undefined || r.model === model));
    // Short answers say little about the decode speed: a few tokens are mostly latency.
    const speeds = recent.filter((r) => r.decodeTps !== undefined && (r.genTokens ?? 0) >= 8).map((r) => r.decodeTps!);
    const ttfts = recent.filter((r) => r.ttft !== undefined).map((r) => r.ttft!);
    const p50 = percentile(0.5, speeds), low = percentile(0.1, speeds);
    const t50 = percentile(0.5, ttfts), t90 = percentile(0.9, ttfts);
    return {
      genTps: this.gen.sum(model, now, w) / (w / 1000),
      promptTps: this.prompt.sum(model, now, w) / (w / 1000),
      ...(p50 !== undefined ? { decodeTps: p50 } : {}),
      ...(low !== undefined ? { lowTps: low } : {}),
      ...(t50 !== undefined ? { ttftP50: t50 } : {}),
      ...(t90 !== undefined ? { ttftP90: t90 } : {}),
      recent: recent.length,
      estimated: recent.some((r) => r.estimated),
    };
  }
}

/* ---------- the listener ---------- */

// Hop-by-hop headers (RFC 9110 §7.6.1): they belong to one connection, not to the message.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);
function endToEnd(h: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const named = String(h.connection ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP.has(k) && !named.includes(k)) out[k] = v;
  return out;
}

export interface ProxyOptions {
  /** The real server, e.g. http://127.0.0.1:11434. */
  upstream: string;
  host: string;
  port: number;
  now?: () => number;
  /** Waits between tries while the port is taken (a previous proxy letting go of it). */
  retryMs?: number[];
}

export interface Proxy {
  readonly log: SpeedLog;
  readonly upstream: string;
  readonly listen: string;
  /** Set once listening. */
  readonly port: number | undefined;
  readonly listening: boolean;
  readonly error: string | undefined;
  /** Resolves when listening (or failed for good). */
  ready: Promise<void>;
  /** Stops listening. Answers under way finish; idle connections close. */
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const RETRY_MS = [250, 500, 1000, 2000, 5000];

/** True when `upstream` is the proxy's own address: it would call itself forever. */
export function pointsAtItself(upstream: string, host: string, port: number): boolean {
  try {
    const u = new URL(upstream);
    const p = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (p !== port) return false;
    const h = u.hostname.toLowerCase();
    return h === host.toLowerCase() || (LOOPBACK.has(h) && (LOOPBACK.has(host) || host === '0.0.0.0' || host === '::'));
  } catch {
    return false;
  }
}

export function startProxy(o: ProxyOptions): Proxy {
  const now = o.now ?? Date.now;
  const up = new URL(o.upstream);
  const lib = up.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true });
  const prefix = up.pathname.replace(/\/+$/, '');
  const log = new SpeedLog();
  const listen = `${o.host.includes(':') ? `[${o.host}]` : o.host}:${o.port}`;
  let error: string | undefined;
  let listening = false;
  let closed = false;
  let boundPort: number | undefined;

  const server = http.createServer((req, res) => {
    const start = now();
    const path = req.url ?? '/';
    const pathname = path.split('?')[0]!;
    const measure = req.method === 'POST' && METERED.test(pathname);
    let meter: ResponseMeter | undefined;
    let upRes: http.IncomingMessage | undefined;
    const end = (complete: boolean) => {
      meter?.finish(now(), complete);
      meter = undefined;
    };
    const headers = endToEnd(req.headers);
    headers.host = up.host;
    const upReq = lib.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, method: req.method, path: prefix + path, headers, agent }, (r) => {
      upRes = r;
      if (measure && (r.statusCode ?? 500) < 400) meter = log.begin(r.headers['content-type'], start);
      res.writeHead(r.statusCode ?? 502, r.statusMessage, endToEnd(r.headers));
      // Headers at once: a client waiting on a slow first token sees the answer has started.
      res.flushHeaders();
      r.on('data', (c: Buffer) => meter?.feed(c, now()));
      r.on('end', () => end(true));
      r.on('error', () => end(false));
      r.on('close', () => end(r.complete));
      r.pipe(res);
    });
    upReq.on('error', (e) => {
      end(false);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `kiosko measuring proxy: ${up.host} did not answer (${(e as NodeJS.ErrnoException).code ?? e.message})` }));
      } else res.destroy();
    });
    // The client went away mid-answer: stop the upstream too, as a direct connection would (the server then stops generating).
    res.on('close', () => {
      if (res.writableFinished) return;
      end(false);
      upRes?.destroy();
      upReq.destroy();
    });
    req.on('error', () => upReq.destroy());
    req.pipe(upReq);
  });
  // Long answers: no timeout of our own past what the client and the server set.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;

  const ready = new Promise<void>((resolve) => {
    if (pointsAtItself(o.upstream, o.host, o.port)) {
      error = 'points at itself';
      return resolve();
    }
    let attempt = 0;
    const tryListen = () => {
      if (closed) return resolve();
      server.once('error', onError);
      server.listen(o.port, o.host, () => {
        server.off('error', onError);
        listening = true;
        error = undefined;
        const a = server.address();
        boundPort = a && typeof a === 'object' ? a.port : o.port;
        resolve();
      });
    };
    const onError = (e: NodeJS.ErrnoException) => {
      error = e.code === 'EADDRINUSE' ? `port ${o.port} in use` : e.code === 'EACCES' ? `port ${o.port} not allowed` : e.code ?? e.message;
      // A previous instance of the proxy may still be letting go of the port (options changed, plugin reloaded).
      const retry = o.retryMs ?? RETRY_MS;
      if (e.code === 'EADDRINUSE' && attempt < retry.length && !closed) {
        const t = setTimeout(tryListen, retry[attempt++]);
        t.unref?.();
      } else resolve();
    };
    tryListen();
  });

  return {
    log,
    upstream: o.upstream,
    listen,
    get port() {
      return boundPort;
    },
    get listening() {
      return listening;
    },
    get error() {
      return error;
    },
    ready,
    close: () =>
      new Promise<void>((resolve) => {
        closed = true;
        listening = false;
        if (!server.listening) return resolve();
        // Upstream sockets go once the last answer under way has finished.
        server.close(() => {
          agent.destroy();
          resolve();
        });
        server.closeIdleConnections();
      }),
  };
}

/* ---------- the proxies the source runs ---------- */

interface Held {
  proxy: Proxy;
  refs: number;
}
const held = new Map<string, Held>();
const keyOf = (host: string, port: number) => `${host.toLowerCase()} ${port}`;

/**
 * Starts (or shares) the proxy for `host:port` in front of `upstream`; the
 * returned function lets it go, and the last one closes it. A different
 * upstream on the same port replaces the old proxy.
 */
export function acquireProxy(o: ProxyOptions): () => void {
  const key = keyOf(o.host, o.port);
  let h = held.get(key);
  if (h && h.proxy.upstream !== o.upstream) {
    void h.proxy.close();
    held.delete(key);
    h = undefined;
  }
  if (!h) held.set(key, (h = { proxy: startProxy(o), refs: 0 }));
  h.refs++;
  const mine = h;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--mine.refs > 0) return;
    if (held.get(key) === mine) held.delete(key);
    void mine.proxy.close();
  };
}

/** The proxy running on `host:port`, if any. */
export function proxyAt(host: string, port: number): Proxy | undefined {
  return held.get(keyOf(host, port))?.proxy;
}

/** Closes them all (tests). */
export async function closeAllProxies(): Promise<void> {
  const all = [...held.values()];
  held.clear();
  await Promise.all(all.map((h) => h.proxy.close()));
}
