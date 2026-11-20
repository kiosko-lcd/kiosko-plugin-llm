/**
 * Local LLM inference at a glance: tokens per second, the models in memory
 * and the request queue of the Ollama, llama.cpp, vLLM, TGI or
 * OpenAI-compatible servers on your LAN. Dark while nothing is generating.
 */
import { defineSource, definePlugin, defineWidget, drawEmpty, drawMore, listLayout, listOptions, matchFilter, t, type Filter, type Graphics, type Localized, type RenderContext } from '@kiosko/sdk';
import { DEFAULT_ENDPOINTS, HISTORY_MS, KINDS, busy, countdown, demoData, fmtBytes, fmtCtx, fmtTps, readServers, type LlmData, type LoadedModel, type ServerStatus } from './llm.ts';

export * from './llm.ts';
export * from './prom.ts';

const SOURCE = 'llm/servers';

export const servers = defineSource({
  id: 'servers',
  name: { en: 'LLM servers', es: 'Servidores de LLM', 'zh-Hant': 'LLM 伺服器', 'zh-Hans': 'LLM 服务器' },
  description: {
    en: 'Local inference servers (Ollama, llama.cpp, vLLM, TGI, OpenAI-compatible): reachability, loaded models, queue, tokens/s, KV cache and time to first token, where each exposes them.',
    es: 'Servidores de inferencia locales (Ollama, llama.cpp, vLLM, TGI, compatibles con OpenAI): si responden, modelos cargados, cola, tokens/s, caché KV y tiempo hasta el primer token, según lo que expone cada uno.',
    'zh-Hant': '本機推論伺服器（Ollama、llama.cpp、vLLM、TGI、OpenAI 相容）：是否可連線、已載入的模型、佇列、tokens/s、KV 快取與首個 token 時間，視各伺服器提供的資料而定。',
    'zh-Hans': '本地推理服务器（Ollama、llama.cpp、vLLM、TGI、兼容 OpenAI）：是否可达、已加载的模型、队列、tokens/s、KV 缓存和首 token 时间，取决于各服务器提供的数据。',
  },
  options: t.object({
    endpoints: t.list(
      t.object({
        name: t.string({ placeholder: 'ollama', label: { en: 'Name', es: 'Nombre', 'zh-Hant': '名稱', 'zh-Hans': '名称' } }),
        kind: t.enum(KINDS, { label: { en: 'Server', es: 'Servidor', 'zh-Hant': '伺服器', 'zh-Hans': '服务器' }, labels: { ollama: 'Ollama', llamacpp: 'llama.cpp server', vllm: 'vLLM', openai: { en: 'OpenAI-compatible (LM Studio…)', es: 'Compatible con OpenAI (LM Studio…)', 'zh-Hant': 'OpenAI 相容（LM Studio…）', 'zh-Hans': '兼容 OpenAI（LM Studio…）' }, tgi: 'TGI' } }),
        url: t.string({ format: 'url', risk: 'network', placeholder: 'http://192.168.1.40:11434', label: { en: 'Address', es: 'Dirección', 'zh-Hant': '位址', 'zh-Hans': '地址' } }),
        token: t.string({ secret: true, label: { en: 'Bearer token', es: 'Token Bearer', 'zh-Hant': 'Bearer 權杖', 'zh-Hans': 'Bearer 令牌' }, help: { en: 'Only if the server asks for an API key.', es: 'Solo si el servidor pide una clave de API.', 'zh-Hant': '僅在伺服器要求 API 金鑰時填寫。', 'zh-Hans': '仅当服务器要求 API 密钥时填写。' } }),
      }),
      { default: DEFAULT_ENDPOINTS, max: 12, label: { en: 'Servers', es: 'Servidores', 'zh-Hant': '伺服器', 'zh-Hans': '服务器' } },
    ),
  }),
  intervalMs: 5000,
  // The whole read: every server is polled in parallel, each with a share of it (see `serverBudget`).
  timeoutMs: 2500,
  read: ({ options, signal, timeoutMs }) => readServers(options.endpoints, { timeoutMs: serverBudget(timeoutMs), signal }),
  demo: ({ now }) => demoData(now),
});

/**
 * How long one server may take, all its requests together: most of the
 * read's timeout, so a server that hangs is reported down before Kiosko
 * gives up the whole read (and with it the servers that did answer).
 */
export function serverBudget(readTimeoutMs: number): number {
  return Math.max(200, Math.round(readTimeoutMs * 0.8));
}

type Ctx = RenderContext<any, unknown>;
type State = { options: { servers: Filter }; sources: Record<string, unknown> };
const dataOf = (sources: Record<string, unknown>) => sources[SOURCE] as LlmData | undefined;
const demo = ({ now }: { now: number }) => ({ sources: { [SOURCE]: demoData(now) } });

/** The `servers` option of every widget: which servers it shows, by name or address. */
const serversOption = () =>
  t.filter({
    label: { en: 'Servers', es: 'Servidores', 'zh-Hant': '伺服器', 'zh-Hans': '服务器' },
    help: { en: 'Empty: all. Names (as in the source) or patterns, comma-separated: * matches anything, a leading ! leaves out (vllm, gpu-*, !ollama).', es: 'Vacío: todos. Nombres (los de la fuente) o patrones separados por comas: * vale por cualquier cosa y un ! delante excluye (vllm, gpu-*, !ollama).', 'zh-Hant': '留空：全部。以逗號分隔的名稱（與資料來源中相同）或模式：* 符合任何內容，開頭加 ! 表示排除（vllm, gpu-*, !ollama）。', 'zh-Hans': '留空：全部。以逗号分隔的名称（与数据源中相同）或模式：* 匹配任意内容，开头加 ! 表示排除（vllm, gpu-*, !ollama）。' },
  });

/** The servers a widget shows: those its `servers` filter lets through. */
export function serversOf(data: LlmData, filter: Filter): ServerStatus[] {
  return data.servers.filter((s) => matchFilter([s.name, s.url], filter));
}

const shownServers = ({ options, sources }: State) => {
  const data = dataOf(sources);
  return data ? serversOf(data, options.servers) : [];
};
// Dark while none of the widget's servers is generating.
const idle = (st: State) => !shownServers(st).some(busy);

/** Why a widget has nothing to show: no servers at all, or none past the filter. */
const noServers = (data: LlmData): Localized => (data.servers.length ? MSG.filtered : MSG.none);

function bars(g: Graphics, ctx: Ctx, values: number[], x: number, y: number, w: number, h: number, color: string) {
  if (values.length < 2 || w < 8 || h < 4) return;
  g.fillStyle = color;
  for (const b of ctx.kit.sparkBars(values, w, h, { gap: 1, minHeight: 1, max: Math.max(1, ...values) })) g.fillRect(x + b.x, y + b.y, b.w, b.h);
}

const MSG = {
  none: { en: 'No servers configured', es: 'Sin servidores configurados', 'zh-Hant': '未設定伺服器', 'zh-Hans': '未配置服务器' },
  filtered: { en: 'No server matches the filter', es: 'Ningún servidor coincide con el filtro', 'zh-Hant': '沒有符合篩選條件的伺服器', 'zh-Hans': '没有符合筛选条件的服务器' },
  down: { en: 'down', es: 'caído', 'zh-Hant': '離線', 'zh-Hans': '离线' },
  noModels: { en: 'No models loaded', es: 'Ningún modelo cargado', 'zh-Hant': '未載入模型', 'zh-Hans': '未加载模型' },
};

/** Servers of the throughput widget: those its filter lets through and, with `onlyWithRate`, that report tokens/s. */
export function rateServers(data: LlmData, o: { servers: Filter; onlyWithRate: boolean }): ServerStatus[] {
  return serversOf(data, o.servers).filter((s) => !o.onlyWithRate || !s.reachable || s.genTps !== undefined || s.history.length > 0);
}

export const throughput = defineWidget({
  id: 'throughput',
  name: { en: 'Tokens per second', es: 'Tokens por segundo', 'zh-Hant': '每秒 token 數', 'zh-Hans': '每秒 token 数' },
  description: {
    en: 'Generation tokens per second of each server in big figures, prompt processing in small, and a sparkline of the last minutes. Dim while idle.',
    es: 'Tokens por segundo generados por cada servidor en grande, el procesado del prompt en pequeño y una gráfica de los últimos minutos. Apagado en reposo.',
    'zh-Hant': '以大字顯示各伺服器每秒生成的 token 數，小字顯示提示處理速度，並附最近幾分鐘的走勢線。閒置時保持暗色。',
    'zh-Hans': '以大字显示各服务器每秒生成的 token 数，小字显示提示词处理速度，并附最近几分钟的迷你走势图。空闲时保持暗色。',
  },
  icon: 'activity',
  category: 'dev',
  tags: ['llm', 'ollama', 'vllm', 'llama.cpp', 'ai'],
  size: { min: { w: 160, h: 90 }, preferred: { w: 720, h: 220 } },
  sources: [SOURCE],
  options: t.object({
    historyMs: t.duration({ default: 10 * 60_000, min: 60_000, max: HISTORY_MS, label: { en: 'Sparkline span', es: 'Duración de la gráfica', 'zh-Hant': '走勢線時長', 'zh-Hans': '走势图时长' }, help: { en: 'Up to 30 min, what the source keeps.', es: 'Hasta 30 min, lo que guarda la fuente.', 'zh-Hant': '最多 30 分鐘，即資料來源保留的長度。', 'zh-Hans': '最多 30 分钟，即数据源保留的长度。' } }),
    onlyWithRate: t.boolean({ default: true, label: { en: 'Only servers that report tokens/s', es: 'Solo servidores que dan tokens/s', 'zh-Hant': '僅限回報 tokens/s 的伺服器', 'zh-Hans': '仅限报告 tokens/s 的服务器' }, help: { en: 'Ollama does not expose tokens/s.', es: 'Ollama no expone tokens/s.', 'zh-Hant': 'Ollama 不提供 tokens/s。', 'zh-Hans': 'Ollama 不提供 tokens/s。' } }),
    servers: serversOption(),
  }),
  idle,
  empty: ({ options, sources }) => {
    const data = dataOf(sources);
    return Boolean(data) && !rateServers(data!, options).length;
  },
  render(g, ctx) {
    const { options, sources, box, theme, kit, now, t: tr } = ctx;
    const data = dataOf(sources);
    if (!data) return;
    const { colors, fonts } = theme;
    const list = rateServers(data, options);
    if (!list.length) {
      const some = serversOf(data, options.servers).length > 0;
      return drawEmpty(g, ctx, tr(some ? { en: 'No server reports tokens/s', es: 'Ningún servidor da tokens/s', 'zh-Hant': '沒有伺服器回報 tokens/s', 'zh-Hans': '没有服务器报告 tokens/s' } : noServers(data)));
    }
    const wide = box.w / box.h >= 2.2;
    const n = list.length;
    const cw = wide ? box.w / n : box.w, ch = wide ? box.h : box.h / n;
    list.forEach((s, i) => {
      const x = box.x + (wide ? i * cw : 0), y = box.y + (wide ? 0 : i * ch);
      const pad = Math.min(cw, ch) * 0.06;
      const w = cw - pad * 2, h = ch - pad;
      const on = busy(s);
      const nameS = Math.round(Math.max(11, Math.min(26, h * 0.16)));
      const name = { size: nameS, family: fonts.sans, color: colors.inkDim };
      kit.drawTracked(g, kit.truncate(g, s.name, w, name), x + pad, y + nameS, name);
      if (!s.reachable) {
        kit.drawTracked(g, tr(MSG.down), x + pad, y + nameS * 2.4, { size: nameS, family: fonts.sans, color: colors.alert });
        return;
      }
      // Big number on the left; sparkline to its right (wide cells) or below (tall ones).
      const bigS = Math.round(Math.max(16, Math.min(h * (wide ? 0.5 : 0.55), w * 0.28)));
      const big = { size: bigS, family: fonts.sansBold, color: on ? colors.ink : colors.inkFaint };
      const by = y + nameS * 1.3 + bigS;
      const bw = kit.drawTracked(g, fmtTps(s.genTps), x + pad, by, big);
      const small = { size: Math.round(bigS * 0.3), family: fonts.sans, color: colors.inkDim };
      kit.drawTracked(g, 'tok/s', x + pad + bw + small.size * 0.4, by, small);
      if (s.promptTps !== undefined) kit.drawTracked(g, `${tr({ en: 'prompt', es: 'prompt', 'zh-Hant': 'prompt', 'zh-Hans': 'prompt' })} ${fmtTps(s.promptTps)}`, x + pad + bw + small.size * 0.4, by - small.size * 1.3, { ...small, color: colors.inkFaint });
      const vals = s.history.filter(([tm]) => tm > now - options.historyMs).map(([, v]) => v);
      const sx = x + pad, sy = by + bigS * 0.12, sw = w, sh = y + ch - pad - sy;
      if (sh > 10) bars(g, ctx, vals, sx, sy, sw, sh, on ? colors.info : colors.inkFaint);
    });
  },
  demo,
});

/** One row of `llm/models`: a loaded model and the server that holds it. */
export interface ModelRow {
  s: ServerStatus;
  m: LoadedModel;
}

export function modelRows(data: LlmData, filter: Filter): ModelRow[] {
  return serversOf(data, filter).flatMap((s) => s.models.map((m) => ({ s, m })));
}

/** "21 GB (87% GPU)", "22 GB VRAM", "640 MB". */
function sizeText(m: LoadedModel): string {
  if (m.vramBytes !== undefined && m.sizeBytes !== undefined && m.vramBytes < m.sizeBytes * 0.98) return `${fmtBytes(m.sizeBytes)} (${Math.round((m.vramBytes / m.sizeBytes) * 100)}% GPU)`;
  return m.vramBytes !== undefined ? `${fmtBytes(m.vramBytes)} VRAM` : fmtBytes(m.sizeBytes);
}

export const models = defineWidget({
  id: 'models',
  name: { en: 'Loaded models', es: 'Modelos cargados', 'zh-Hant': '已載入模型', 'zh-Hans': '已加载模型' },
  description: {
    en: 'The models in memory across your servers: size and VRAM, context length and, for Ollama, how long until keep-alive unloads them.',
    es: 'Los modelos en memoria en tus servidores: tamaño y VRAM, longitud de contexto y, en Ollama, cuánto falta para que el keep-alive los descargue.',
    'zh-Hant': '你各伺服器記憶體中的模型：大小與顯示記憶體、上下文長度，以及 Ollama 的 keep-alive 還有多久會將其卸載。',
    'zh-Hans': '你各服务器内存中的模型：大小和显存、上下文长度，以及 Ollama 的 keep-alive 还有多久将其卸载。',
  },
  icon: 'cpu',
  category: 'dev',
  tags: ['llm', 'ollama', 'vram', 'ai'],
  size: { min: { w: 220, h: 80 }, preferred: { w: 600, h: 220 } },
  sources: [SOURCE],
  options: t.object({
    showServer: t.boolean({ default: true, label: { en: 'Show the server name', es: 'Mostrar el servidor', 'zh-Hant': '顯示伺服器名稱', 'zh-Hans': '显示服务器名称' } }),
    servers: serversOption(),
    ...listOptions({ layouts: ['one-line', 'detailed'] }),
  }),
  redraw: { everyMs: 5000 },
  idle,
  empty: ({ options, sources }) => {
    const data = dataOf(sources);
    return Boolean(data) && !modelRows(data!, options.servers).length;
  },
  render(g, ctx) {
    const { options, sources, box, theme, kit, now, t: tr } = ctx;
    const data = dataOf(sources);
    if (!data) return;
    const { colors, fonts } = theme;
    const rows = modelRows(data, options.servers);
    if (!rows.length) return drawEmpty(g, ctx, tr(serversOf(data, options.servers).length ? MSG.noModels : noServers(data)));
    const plan = listLayout(box, rows.length, options, {
      sizes: { 'one-line': { min: 18, max: 44 }, detailed: { min: 34, max: 80 } },
      // Two lines while every row still has room for them.
      auto: (b, n) => (b.h / Math.max(1, n) >= 34 ? 'detailed' : 'one-line'),
    });
    const detailed = plan.layout === 'detailed';
    const ts = Math.round(plan.rowH * (detailed ? 0.42 : 0.56));
    const ms = Math.round(detailed ? plan.rowH * 0.3 : ts * 0.78);
    plan.rows.forEach((row, i) => {
      const { s, m } = rows[i]!;
      const on = busy(s);
      const base = detailed ? row.y + ts : row.y + row.h * 0.5 + ts * 0.36;
      const left = countdown(m.expiresAt, now);
      const soon = m.expiresAt !== undefined && Date.parse(m.expiresAt) - now < 60_000;
      const cd = { size: detailed ? ts : ms, family: fonts.mono, color: soon ? colors.warn : colors.inkDim };
      const cw = left ? kit.drawTracked(g, left, box.x + box.w, base, { ...cd, align: 'right' }) : 0;
      const room = box.w - cw - (cw ? ts * 0.6 : 0);
      const title = { size: ts, family: fonts.sans, color: on ? colors.ink : colors.inkDim };
      const nw = kit.drawTracked(g, kit.truncate(g, m.name, room, title), box.x, base, title);
      const mo = { size: ms, family: fonts.mono, color: colors.inkFaint };
      if (detailed) {
        const meta = [options.showServer ? s.name : '', sizeText(m), m.contextLength ? `ctx ${fmtCtx(m.contextLength)}` : '', m.quantization ?? ''].filter(Boolean).join(' · ');
        kit.drawTracked(g, kit.truncate(g, meta, box.w, mo), box.x, base + ms * 1.35, mo);
        return;
      }
      // One line: the server and the size after the name, in what's left.
      const meta = [options.showServer ? s.name : '', sizeText(m)].filter(Boolean).join(' · ');
      const gap = ts * 0.5;
      if (meta && room - nw - gap > ms * 3) kit.drawTracked(g, kit.truncate(g, meta, room - nw - gap, mo), box.x + nw + gap, base, mo);
    });
    drawMore(g, ctx, plan);
  },
  demo,
});

/** Over a threshold: waiting requests or KV cache. */
export function congested(s: ServerStatus, o: { waitingAlert: number; kvAlert: number }): boolean {
  return s.reachable && ((s.waiting ?? 0) >= o.waitingAlert || (s.kvUsage ?? 0) * 100 >= o.kvAlert);
}

/** Amber from `warn`, red from `alert`, quiet below. */
export function thresholdLevel(value: number, warn: number, alert: number): 'ok' | 'warn' | 'alert' {
  return value >= alert ? 'alert' : value >= warn ? 'warn' : 'ok';
}

/** Servers of the queue widget: those its filter lets through and, with `onlyWithQueue`, that report a queue. */
export function queueServers(data: LlmData, o: { servers: Filter; onlyWithQueue: boolean }): ServerStatus[] {
  return serversOf(data, o.servers).filter((s) => !o.onlyWithQueue || !s.reachable || s.running !== undefined || s.kvUsage !== undefined);
}

export const queue = defineWidget({
  id: 'queue',
  name: { en: 'Inference queue', es: 'Cola de inferencia', 'zh-Hant': '推論佇列', 'zh-Hans': '推理队列' },
  description: {
    en: 'Requests running and waiting on each server, with its KV cache usage. Turns red, and keeps the tile, when too many wait or the cache is nearly full.',
    es: 'Peticiones en curso y en espera en cada servidor, con el uso de su caché KV. Se pone en rojo, y se queda la tesela, si esperan demasiadas o la caché está casi llena.',
    'zh-Hant': '各伺服器執行中與等待中的請求，以及其 KV 快取用量。等待的請求過多或快取將滿時會變紅，並持續佔用方格。',
    'zh-Hans': '各服务器运行中和等待中的请求，以及其 KV 缓存用量。等待的请求过多或缓存将满时会变红，并持续占用格子。',
  },
  icon: 'layers',
  category: 'dev',
  tags: ['llm', 'vllm', 'llama.cpp', 'ai'],
  size: { min: { w: 220, h: 80 }, preferred: { w: 600, h: 200 } },
  sources: [SOURCE],
  options: t.object({
    waitingWarn: t.integer({ default: 1, min: 1, max: 100, label: { en: 'Amber when this many requests wait', es: 'Ámbar cuando esperan estas peticiones', 'zh-Hant': '等待請求達此數量時顯示琥珀色', 'zh-Hans': '等待请求达到此数量时显示琥珀色' } }),
    waitingAlert: t.integer({ default: 3, min: 1, max: 100, label: { en: 'Red when this many requests wait', es: 'Rojo cuando esperan estas peticiones', 'zh-Hant': '等待請求達此數量時顯示紅色', 'zh-Hans': '等待请求达到此数量时显示红色' } }),
    kvWarn: t.integer({ default: 75, min: 10, max: 100, unit: '%', slider: true, label: { en: 'Amber when the KV cache reaches', es: 'Ámbar cuando la caché KV llega a', 'zh-Hant': 'KV 快取達到此值時顯示琥珀色', 'zh-Hans': 'KV 缓存达到此值时显示琥珀色' } }),
    kvAlert: t.integer({ default: 90, min: 10, max: 100, unit: '%', slider: true, label: { en: 'Red when the KV cache reaches', es: 'Rojo cuando la caché KV llega a', 'zh-Hant': 'KV 快取達到此值時顯示紅色', 'zh-Hans': 'KV 缓存达到此值时显示红色' } }),
    onlyWithQueue: t.boolean({ default: true, label: { en: 'Only servers that report a queue', es: 'Solo servidores que dan cola', 'zh-Hant': '僅限回報佇列的伺服器', 'zh-Hans': '仅限报告队列的服务器' } }),
    servers: serversOption(),
    ...listOptions(),
  }),
  idle,
  urgent: ({ options, sources }) => shownServers({ options, sources }).some((s) => congested(s, options)),
  empty: ({ options, sources }) => {
    const data = dataOf(sources);
    return Boolean(data) && !queueServers(data!, options).length;
  },
  render(g, ctx) {
    const { options, sources, box, theme, kit, t: tr } = ctx;
    const data = dataOf(sources);
    if (!data) return;
    const { colors, fonts } = theme;
    const list = queueServers(data, options);
    if (!list.length) {
      const some = serversOf(data, options.servers).length > 0;
      return drawEmpty(g, ctx, tr(some ? { en: 'No server reports a queue', es: 'Ningún servidor da cola', 'zh-Hant': '沒有伺服器回報佇列', 'zh-Hans': '没有服务器报告队列' } : noServers(data)));
    }
    const plan = listLayout(box, list.length, options, { sizes: { detailed: { min: 30, max: 90 } } });
    const rowH = plan.rowH;
    const ts = Math.round(rowH * 0.36);
    plan.rows.forEach((row, i) => {
      const s = list[i]!;
      const top = row.y;
      const hot = congested(s, options);
      const on = busy(s);
      const name = { size: ts, family: fonts.sans, color: hot ? colors.alert : on ? colors.ink : colors.inkDim };
      if (!s.reachable) {
        const dw = kit.drawTracked(g, tr(MSG.down), box.x + box.w, top + ts, { size: ts, family: fonts.sans, color: colors.alert, align: 'right' });
        kit.drawTracked(g, kit.truncate(g, s.name, box.w - dw - ts, name), box.x, top + ts, { ...name, color: colors.inkDim });
        return;
      }
      const full = `${s.running ?? '–'} ${tr({ en: 'run', es: 'en curso', 'zh-Hant': '執行', 'zh-Hans': '运行' })} · ${s.waiting ?? '–'} ${tr({ en: 'wait', es: 'esperan', 'zh-Hant': '等待', 'zh-Hans': '等待' })}`;
      // At most two thirds of the row: a bit smaller first, then the numbers alone ("2 · 1"), never out of the box.
      const room = box.w * 0.66;
      const wait = thresholdLevel(s.waiting ?? 0, options.waitingWarn, options.waitingAlert);
      const base = { family: fonts.mono, color: wait === 'alert' ? colors.alert : wait === 'warn' ? colors.warn : on ? colors.info : colors.inkFaint };
      const fitted = kit.fitSize(g, full, room, { ...base, size: ts }, Math.max(9, Math.round(ts * 0.75)));
      const counts = kit.measureTracked(g, full, { ...base, size: fitted }) <= room ? full : `${s.running ?? '–'} · ${s.waiting ?? '–'}`;
      const co = { ...base, size: counts === full ? fitted : ts };
      const cw = kit.drawTracked(g, kit.truncate(g, counts, box.w, co), box.x + box.w, top + ts, { ...co, align: 'right' });
      kit.drawTracked(g, kit.truncate(g, s.name, box.w - cw - ts, name), box.x, top + ts, name);
      if (s.kvUsage !== undefined) {
        const kv = thresholdLevel(s.kvUsage * 100, options.kvWarn, options.kvAlert);
        const kvHot = kv === 'alert';
        const kvColor = kvHot ? colors.alert : kv === 'warn' ? colors.warn : null;
        const by = top + ts * 1.45, bh = Math.max(4, rowH * 0.22);
        const lab = { size: Math.round(bh * 1.1), family: fonts.mono, color: kvColor ?? colors.inkDim };
        const lw = kit.drawTracked(g, `KV ${Math.round(s.kvUsage * 100)}%`, box.x + box.w, by + bh, { ...lab, align: 'right' });
        const bw = box.w - lw - ts * 0.5;
        g.fillStyle = colors.surfaceEdge;
        g.fillRect(box.x, by, bw, bh);
        g.fillStyle = kvColor ?? (on ? colors.info : colors.inkFaint);
        g.fillRect(box.x, by, bw * Math.min(1, Math.max(0, s.kvUsage)), bh);
      }
    });
    drawMore(g, ctx, plan);
  },
  demo,
});

export const status = defineWidget({
  id: 'status',
  name: { en: 'LLM servers', es: 'Servidores LLM', 'zh-Hant': 'LLM 伺服器', 'zh-Hans': 'LLM 服务器' },
  description: {
    en: 'One line per server for small panels: up or down, the loaded model and its tokens per second.',
    es: 'Una línea por servidor para pantallas pequeñas: si está activo, el modelo cargado y sus tokens por segundo.',
    'zh-Hant': '每台伺服器一行，適合小面板：是否上線、已載入的模型及其每秒 token 數。',
    'zh-Hans': '每台服务器一行，适合小屏幕：是否在线、已加载的模型及其每秒 token 数。',
  },
  icon: 'server',
  category: 'dev',
  tags: ['llm', 'ollama', 'ai'],
  size: { min: { w: 140, h: 40 }, preferred: { w: 320, h: 160 } },
  sources: [SOURCE],
  options: t.object({
    servers: serversOption(),
    ...listOptions(),
  }),
  idle,
  empty: ({ options, sources }) => Boolean(dataOf(sources)) && !shownServers({ options, sources }).length,
  render(g, ctx) {
    const { options, sources, box, theme, kit, t: tr } = ctx;
    const data = dataOf(sources);
    if (!data) return;
    const { colors, fonts } = theme;
    const list = serversOf(data, options.servers);
    if (!list.length) return drawEmpty(g, ctx, tr(noServers(data)));
    const plan = listLayout(box, list.length, options, { sizes: { 'one-line': { min: 18, max: 48 } } });
    const s0 = Math.round(plan.rowH * 0.62);
    const dot = s0 * 0.26;
    const x0 = box.x + dot * 3;
    plan.rows.forEach((row, i) => {
      const s = list[i]!;
      const base = row.y + row.h * 0.72;
      const on = busy(s);
      g.fillStyle = !s.reachable ? colors.alert : on ? colors.info : colors.inkFaint;
      g.beginPath();
      g.arc(box.x + dot, base - s0 * 0.33, dot, 0, Math.PI * 2);
      g.fill();
      const right = !s.reachable ? tr(MSG.down) : s.genTps !== undefined ? `${fmtTps(s.genTps)} t/s` : '';
      const ro = { size: s0, family: fonts.mono, color: !s.reachable ? colors.alert : on ? colors.ink : colors.inkFaint };
      const rw = right ? kit.drawTracked(g, right, box.x + box.w, base, { ...ro, align: 'right' }) : 0;
      const label = s.models[0] ? `${s.name} · ${s.models[0].name}` : s.name;
      const lo = { size: s0, family: fonts.sans, color: on ? colors.ink : colors.inkDim };
      kit.drawTracked(g, kit.truncate(g, label, box.x + box.w - x0 - rw - s0 * 0.4, lo), x0, base, lo);
    });
    drawMore(g, ctx, plan, { indent: x0 - box.x });
  },
  demo,
});

export default definePlugin({
  id: 'llm',
  name: { en: 'Local LLMs', es: 'LLM locales', 'zh-Hant': '本機 LLM', 'zh-Hans': '本地大模型' },
  version: '0.2.1',
  sdk: '^0.2.0',
  permissions: { network: ['user'] },
  description: { en: 'Tokens per second, loaded models and request queues of your local LLM servers.', es: 'Tokens por segundo, modelos cargados y colas de peticiones de tus servidores de LLM locales.', 'zh-Hant': '你本機 LLM 伺服器的每秒 token 數、已載入模型與請求佇列。', 'zh-Hans': '你本地大模型服务器的每秒 token 数、已加载模型和请求队列。' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'cpu',
  widgets: [throughput, models, queue, status],
  sources: [servers],
});
