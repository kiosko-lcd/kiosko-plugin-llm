/**
 * Reading the speed of one answer from the answer itself, as it passes
 * through the measuring proxy: the counts and timings servers put in their
 * last chunk (Ollama's `eval_count`/`eval_duration`, llama.cpp's and
 * Ollama's OpenAI `timings`, LM Studio's `stats`, OpenAI `usage`), and the
 * wall-clock time of the chunks. Text is parsed only to find those fields:
 * nothing of it is kept once a chunk has been looked at.
 */

/** What a response says about its own speed (any subset). */
export interface UsageInfo {
  model?: string;
  genTokens?: number;
  /** Seconds the server spent generating (decode), its own measure. */
  genSeconds?: number;
  promptTokens?: number;
  promptSeconds?: number;
  loadSeconds?: number;
  /** Time to first token as the server measured it. */
  ttftSeconds?: number;
  /** Generation tokens per second as the server measured it (LM Studio). */
  tps?: number;
}

/** One answer, measured. Counts and times only. */
export interface RequestRecord {
  model: string;
  /** Epoch ms: request received, first token seen, answer over. */
  start: number;
  firstAt?: number;
  end: number;
  streamed: boolean;
  /** The upstream finished the answer (not cut by the client or an error). */
  complete: boolean;
  genTokens?: number;
  /** True when the count is the proxy's (one token per chunk), not the server's. */
  estimated: boolean;
  promptTokens?: number;
  /** Generation tokens per second of this answer (decode only). */
  decodeTps?: number;
  promptTps?: number;
  /** Seconds to the first token: wall clock when streamed, else the server's figure. */
  ttft?: number;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const nonEmpty = (v: unknown) => (typeof v === 'string' ? v.length > 0 : Array.isArray(v) ? v.length > 0 : false);
const NS = 1e9;

type Obj = Record<string, any>;

function fromTimings(t: Obj | undefined, u: UsageInfo): void {
  if (!t || typeof t !== 'object') return;
  const pn = num(t.predicted_n), pms = num(t.predicted_ms), qn = num(t.prompt_n), qms = num(t.prompt_ms);
  if (pn !== undefined) u.genTokens = pn;
  if (pms !== undefined && pms > 0) u.genSeconds = pms / 1000;
  if (qn !== undefined) u.promptTokens = qn;
  if (qms !== undefined && qms > 0) u.promptSeconds = qms / 1000;
}

function fromUsage(us: Obj | undefined, u: UsageInfo): void {
  if (!us || typeof us !== 'object') return;
  const out = num(us.completion_tokens) ?? num(us.output_tokens);
  const inp = num(us.prompt_tokens) ?? num(us.input_tokens);
  if (out !== undefined && u.genTokens === undefined) u.genTokens = out;
  if (inp !== undefined && u.promptTokens === undefined) u.promptTokens = inp;
}

/** LM Studio: `stats` of its REST API (v0 and v1). */
function fromStats(s: Obj | undefined, u: UsageInfo): void {
  if (!s || typeof s !== 'object') return;
  const tps = num(s.tokens_per_second);
  if (tps !== undefined && tps > 0) u.tps = tps;
  const ttft = num(s.time_to_first_token_seconds) ?? num(s.time_to_first_token);
  if (ttft !== undefined) u.ttftSeconds = ttft;
  const out = num(s.total_output_tokens);
  if (out !== undefined) u.genTokens = out;
  const inp = num(s.input_tokens);
  if (inp !== undefined) u.promptTokens = inp;
  const load = num(s.model_load_time_seconds);
  if (load !== undefined) u.loadSeconds = load;
}

/**
 * Looks at one JSON object of a response (a chunk, an event, or the whole
 * body): the speed fields it carries, and whether it carries a token of the
 * answer (text, reasoning or a tool call).
 */
export function inspect(o: unknown): { usage: UsageInfo; token: boolean } {
  const u: UsageInfo = {};
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { usage: u, token: false };
  const x = o as Obj;
  let token = false;
  const model = str(x.model) ?? str(x.model_instance_id);
  if (model) u.model = model;

  // Ollama's own API (/api/generate, /api/chat): `done` on every chunk, the figures on the last.
  if (typeof x.done === 'boolean') {
    if (!x.done) token = nonEmpty(x.response) || nonEmpty(x.thinking) || nonEmpty(x.message?.content) || nonEmpty(x.message?.thinking) || nonEmpty(x.message?.tool_calls);
    else {
      const ec = num(x.eval_count), ed = num(x.eval_duration), pc = num(x.prompt_eval_count), pd = num(x.prompt_eval_duration), ld = num(x.load_duration);
      if (ec !== undefined) u.genTokens = ec;
      if (ed !== undefined && ed > 0) u.genSeconds = ed / NS;
      if (pc !== undefined) u.promptTokens = pc;
      if (pd !== undefined && pd > 0) u.promptSeconds = pd / NS;
      if (ld !== undefined) u.loadSeconds = ld / NS;
    }
  }

  // OpenAI chat and completions, from any server: tokens in `choices`, counts in `usage`, llama.cpp/Ollama add `timings`.
  if (Array.isArray(x.choices)) {
    for (const c of x.choices) {
      const d = c?.delta;
      if (d && (nonEmpty(d.content) || nonEmpty(d.reasoning_content) || nonEmpty(d.reasoning) || nonEmpty(d.tool_calls))) token = true;
      if (x.object === 'text_completion' && nonEmpty(c?.text) && x.usage == null && x.timings == null) token = true;
    }
  }
  fromTimings(x.timings, u);
  fromStats(x.stats, u);
  fromUsage(x.usage, u);

  // Typed events: LM Studio's REST API v1, OpenAI Responses, Anthropic Messages (Ollama speaks both).
  const type = str(x.type);
  if (type) {
    if (type === 'message.delta' || type === 'reasoning.delta' || type === 'tool_call.arguments') token = true;
    else if (type === 'chat.end' && x.result) {
      const m = str(x.result.model_instance_id);
      if (m) u.model = m;
      fromStats(x.result.stats, u);
    } else if (type === 'chat.start') {
      const m = str(x.model_instance_id);
      if (m) u.model = m;
    } else if (/^response\.(output_text|reasoning_text|reasoning_summary_text|function_call_arguments)\.delta$/.test(type)) token = true;
    else if ((type === 'response.completed' || type === 'response.incomplete') && x.response) {
      const m = str(x.response.model);
      if (m) u.model = m;
      fromUsage(x.response.usage, u);
    } else if (type === 'content_block_delta') token = true;
    else if (type === 'message_start' && x.message) {
      const m = str(x.message.model);
      if (m) u.model = m;
      const inp = num(x.message.usage?.input_tokens);
      if (inp !== undefined) u.promptTokens = inp;
    } else if (type === 'message_delta') {
      const out = num(x.usage?.output_tokens);
      if (out !== undefined) u.genTokens = out;
    }
  }
  return { usage: u, token };
}

/** Later fields win: the last chunk carries the totals. */
function merge(into: UsageInfo, from: UsageInfo): void {
  for (const k of Object.keys(from) as (keyof UsageInfo)[]) if (from[k] !== undefined) (into as Record<string, unknown>)[k] = from[k];
}

export type Framing = 'sse' | 'ndjson' | 'json';

/** How a response body is cut into objects, by its content type. */
export function framingOf(contentType: string | undefined): Framing {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('text/event-stream')) return 'sse';
  if (ct.includes('ndjson') || ct.includes('jsonl') || ct.includes('json-seq')) return 'ndjson';
  return 'json';
}

/** A whole JSON body (not streamed) is read up to this; bigger ones go unmeasured. */
export const MAX_BODY = 8 * 1024 * 1024;
/** One line of a stream; longer ones (a huge tool call) are skipped, not kept. */
export const MAX_LINE = 1024 * 1024;

export interface MeterHooks {
  /** A token of the answer was seen (live throughput). `model` may still be ''. */
  onToken?: (model: string, at: number) => void;
}

/**
 * Follows one response as its bytes go by. `feed` every chunk with the time
 * it arrived, then `finish` once: it returns the answer's record (or
 * undefined if it said nothing measurable).
 */
export class ResponseMeter {
  readonly framing: Framing;
  readonly start: number;
  usage: UsageInfo = {};
  chunks = 0;
  firstAt?: number;
  lastAt?: number;
  private buf = '';
  private skipping = false;
  private body: string[] = [];
  private bodyBytes = 0;
  private sseData: string[] = [];
  private decoder = new TextDecoder();
  private done = false;
  private readonly hooks: MeterHooks;

  constructor(contentType: string | undefined, start: number, hooks: MeterHooks = {}) {
    this.framing = framingOf(contentType);
    this.start = start;
    this.hooks = hooks;
  }

  get model(): string {
    return this.usage.model ?? '';
  }

  feed(chunk: Uint8Array, at: number): void {
    if (this.done) return;
    const text = this.decoder.decode(chunk, { stream: true });
    if (this.framing === 'json') {
      this.bodyBytes += chunk.byteLength;
      if (this.bodyBytes <= MAX_BODY) this.body.push(text);
      else this.body = [];
      return;
    }
    let s = this.buf + text;
    let nl: number;
    while ((nl = s.indexOf('\n')) >= 0) {
      const line = s.slice(0, nl);
      s = s.slice(nl + 1);
      if (this.skipping) this.skipping = false;
      else this.line(line.endsWith('\r') ? line.slice(0, -1) : line, at);
    }
    if (s.length > MAX_LINE) {
      s = '';
      this.skipping = true;
    }
    this.buf = s;
  }

  private line(line: string, at: number): void {
    if (this.framing === 'ndjson') {
      if (line.trim()) this.object(line, at);
      return;
    }
    // Server-sent events: `data:` lines up to a blank line make one event.
    if (line === '') {
      if (this.sseData.length) {
        const data = this.sseData.join('\n');
        this.sseData = [];
        if (data.trim() !== '[DONE]') this.object(data, at);
      }
      return;
    }
    if (line.startsWith('data:')) this.sseData.push(line.slice(line[5] === ' ' ? 6 : 5));
  }

  private object(text: string, at: number): void {
    let o: unknown;
    try {
      o = JSON.parse(text);
    } catch {
      return;
    }
    const { usage, token } = inspect(o);
    merge(this.usage, usage);
    if (token) {
      this.chunks++;
      this.firstAt ??= at;
      this.lastAt = at;
      this.hooks.onToken?.(this.model, at);
    }
  }

  /** The answer is over: `complete` when the upstream ended it, false when cut. */
  finish(end: number, complete: boolean): RequestRecord | undefined {
    if (this.done) return undefined;
    this.done = true;
    if (this.framing === 'json') {
      if (this.body.length) {
        try {
          merge(this.usage, inspect(JSON.parse(this.body.join('') + this.decoder.decode())).usage);
        } catch {
          /* not JSON, or cut short */
        }
      }
      this.body = [];
    } else if (this.buf && !this.skipping) {
      // A last line with no newline after it.
      if (this.framing === 'ndjson') this.line(this.buf, end);
      else {
        this.line(this.buf, end);
        this.line('', end);
      }
    } else if (this.framing === 'sse' && this.sseData.length) this.line('', end);
    this.buf = '';
    return recordOf(this, end, complete);
  }
}

function recordOf(m: ResponseMeter, end: number, complete: boolean): RequestRecord | undefined {
  const u = m.usage;
  const streamed = m.framing !== 'json';
  const exact = u.genTokens;
  const genTokens = exact ?? (m.chunks > 0 ? m.chunks : undefined);
  if (genTokens === undefined && u.promptTokens === undefined) return undefined;
  // Decode speed: the server's own figure first, then its token count over its decode time, then the chunks' clock.
  let decodeTps = u.tps;
  if (decodeTps === undefined && genTokens && u.genSeconds) decodeTps = genTokens / u.genSeconds;
  if (decodeTps === undefined && genTokens && genTokens >= 2 && m.firstAt !== undefined && m.lastAt !== undefined && m.lastAt > m.firstAt) decodeTps = (genTokens - 1) / ((m.lastAt - m.firstAt) / 1000);
  const promptTps = u.promptTokens && u.promptSeconds ? u.promptTokens / u.promptSeconds : undefined;
  let ttft: number | undefined;
  if (streamed && m.firstAt !== undefined) ttft = (m.firstAt - m.start) / 1000;
  else if (u.ttftSeconds !== undefined) ttft = u.ttftSeconds;
  else if (u.promptSeconds !== undefined) ttft = u.promptSeconds + (u.loadSeconds ?? 0);
  return {
    model: m.model,
    start: m.start,
    ...(m.firstAt !== undefined ? { firstAt: m.firstAt } : {}),
    end,
    streamed,
    complete,
    ...(genTokens !== undefined ? { genTokens } : {}),
    estimated: exact === undefined,
    ...(u.promptTokens !== undefined ? { promptTokens: u.promptTokens } : {}),
    ...(decodeTps !== undefined && Number.isFinite(decodeTps) ? { decodeTps } : {}),
    ...(promptTps !== undefined && Number.isFinite(promptTps) ? { promptTps } : {}),
    ...(ttft !== undefined && ttft >= 0 ? { ttft } : {}),
  };
}
