/**
 * Local LLM inference at a glance: tokens per second, the models in memory
 * and the request queue of the Ollama, llama.cpp, vLLM, TGI or
 * OpenAI-compatible servers on your LAN. Dark while nothing is generating.
 */
import { defineSource, definePlugin, defineWidget, t, type Graphics, type RenderContext } from '@kiosko/sdk';
import { DEFAULT_ENDPOINTS, KINDS, busy, countdown, demoData, fmtBytes, fmtCtx, fmtTps, readServers, type LlmData, type ServerStatus } from './llm.ts';

export * from './llm.ts';
export * from './prom.ts';

const SOURCE = 'llm/servers';

export const servers = defineSource({
  id: 'servers',
  name: { en: 'LLM servers', es: 'Servidores de LLM' },
  description: {
    en: 'Local inference servers (Ollama, llama.cpp, vLLM, TGI, OpenAI-compatible): reachability, loaded models, queue, tokens/s, KV cache and time to first token, where each exposes them.',
    es: 'Servidores de inferencia locales (Ollama, llama.cpp, vLLM, TGI, compatibles con OpenAI): si responden, modelos cargados, cola, tokens/s, caché KV y tiempo hasta el primer token, según lo que expone cada uno.',
  },
  options: t.object({
    endpoints: t.list(
      t.object({
        name: t.string({ placeholder: 'ollama', label: { en: 'Name', es: 'Nombre' } }),
        kind: t.enum(KINDS, { label: { en: 'Server', es: 'Servidor' }, labels: { ollama: 'Ollama', llamacpp: 'llama.cpp server', vllm: 'vLLM', openai: { en: 'OpenAI-compatible (LM Studio…)', es: 'Compatible con OpenAI (LM Studio…)' }, tgi: 'TGI' } }),
        url: t.string({ format: 'url', placeholder: 'http://192.168.1.40:11434', label: { en: 'Address', es: 'Dirección' } }),
        token: t.string({ secret: true, label: { en: 'Bearer token', es: 'Token Bearer' }, help: { en: 'Only if the server asks for an API key.', es: 'Solo si el servidor pide una clave de API.' } }),
      }),
      { default: DEFAULT_ENDPOINTS, max: 12, label: { en: 'Servers', es: 'Servidores' } },
    ),
    timeoutMs: t.duration({ default: 2000, min: 250, max: 10_000, advanced: true, label: { en: 'Timeout per request', es: 'Tiempo máximo por petición' } }),
  }),
  intervalMs: 5000,
  read: ({ options, signal }) => readServers(options.endpoints, { timeoutMs: options.timeoutMs, signal }),
  demo: ({ now }) => demoData(now),
});

type Ctx = RenderContext<any, unknown>;
const dataOf = (sources: Record<string, unknown>) => sources[SOURCE] as LlmData | undefined;
const anyBusy = ({ sources }: { sources: Record<string, unknown> }) => Boolean(dataOf(sources)?.servers.some(busy));
const demo = ({ now }: { now: number }) => ({ sources: { [SOURCE]: demoData(now) } });

function message(g: Graphics, { box, theme, kit }: Ctx, text: string) {
  const s = Math.round(Math.max(12, Math.min(32, box.h * 0.3)));
  const o = { size: s, family: theme.fonts.sans, color: theme.colors.inkDim };
  kit.drawTracked(g, kit.truncate(g, text, box.w, o), box.x, box.y + s * 1.1, o);
}

function bars(g: Graphics, ctx: Ctx, values: number[], x: number, y: number, w: number, h: number, color: string) {
  if (values.length < 2 || w < 8 || h < 4) return;
  g.fillStyle = color;
  for (const b of ctx.kit.sparkBars(values, w, h, { gap: 1, minHeight: 1, max: Math.max(1, ...values) })) g.fillRect(x + b.x, y + b.y, b.w, b.h);
}

const MSG = {
  none: { en: 'No servers configured', es: 'Sin servidores configurados' },
  down: { en: 'down', es: 'caído' },
  noModels: { en: 'No models loaded', es: 'Ningún modelo cargado' },
};

export const throughput = defineWidget({
  id: 'throughput',
  name: { en: 'Tokens per second', es: 'Tokens por segundo' },
  description: {
    en: 'Generation tokens per second of each server in big figures, prompt processing in small, and a sparkline of the last minutes. Dim while idle.',
    es: 'Tokens por segundo generados por cada servidor en grande, el procesado del prompt en pequeño y una gráfica de los últimos minutos. Apagado en reposo.',
  },
  icon: 'activity',
  category: 'dev',
  tags: ['llm', 'ollama', 'vllm', 'llama.cpp', 'ai'],
  size: { min: { w: 160, h: 90 }, preferred: { w: 720, h: 220 } },
  sources: [SOURCE],
  options: t.object({
    minutes: t.integer({ default: 10, min: 1, max: 30, unit: 'min', label: { en: 'Sparkline span', es: 'Duración de la gráfica' } }),
    onlyWithRate: t.boolean({ default: true, label: { en: 'Only servers that report tokens/s', es: 'Solo servidores que dan tokens/s' }, help: { en: 'Ollama does not expose tokens/s.', es: 'Ollama no expone tokens/s.' } }),
  }),
  idle: (s) => !anyBusy(s),
  render(g, ctx) {
    const { options, sources, box, theme, kit, now, t: tr } = ctx;
    const data = dataOf(sources);
    if (!data) return;
    const { colors, fonts } = theme;
    const list = data.servers.filter((s) => !options.onlyWithRate || !s.reachable || s.genTps !== undefined || s.history.length);
    if (!list.length) return message(g, ctx, tr(data.servers.length ? { en: 'No server reports tokens/s', es: 'Ningún servidor da tokens/s' } : MSG.none));
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
      if (s.promptTps !== undefined) kit.drawTracked(g, `${tr({ en: 'prompt', es: 'prompt' })} ${fmtTps(s.promptTps)}`, x + pad + bw + small.size * 0.4, by - small.size * 1.3, { ...small, color: colors.inkFaint });
      const vals = s.history.filter(([tm]) => tm > now - options.minutes * 60_000).map(([, v]) => v);
      const sx = x + pad, sy = by + bigS * 0.12, sw = w, sh = y + ch - pad - sy;
      if (sh > 10) bars(g, ctx, vals, sx, sy, sw, sh, on ? colors.info : colors.inkFaint);
    });
  },
  demo,
});

export const models = defineWidget({
  id: 'models',
  name: { en: 'Loaded models', es: 'Modelos cargados' },
  description: {
    en: 'The models in memory across your servers: size and VRAM, context length and, for Ollama, how long until keep-alive unloads them.',
    es: 'Los modelos en memoria en tus servidores: tamaño y VRAM, longitud de contexto y, en Ollama, cuánto falta para que el keep-alive los descargue.',
  },
  icon: 'cpu',
  category: 'dev',
  tags: ['llm', 'ollama', 'vram', 'ai'],
  size: { min: { w: 220, h: 80 }, preferred: { w: 600, h: 220 } },
  sources: [SOURCE],
  options: t.object({
    showServer: t.boolean({ default: true, label: { en: 'Show the server name', es: 'Mostrar el servidor' } }),
  }),
  redraw: { everyMs: 5000 },
  idle: (s) => !anyBusy(s),
  render(g, ctx) {
    const { options, sources, box, theme, kit, now, t: tr } = ctx;
    const data = dataOf(sources);
    if (!data) return;
    const { colors, fonts } = theme;
    const rows = data.servers.flatMap((s) => s.models.map((m) => ({ s, m })));
    if (!rows.length) return message(g, ctx, tr(data.servers.length ? MSG.noModels : MSG.none));
    const rowH = Math.max(34, Math.min(80, box.h / rows.length));
    const fit = Math.max(1, Math.floor(box.h / rowH + 0.1));
    const ts = Math.round(rowH * 0.42), ms = Math.round(rowH * 0.3);
    rows.slice(0, fit).forEach(({ s, m }, i) => {
      const top = box.y + i * rowH;
      const on = busy(s);
      const left = countdown(m.expiresAt, now);
      const soon = m.expiresAt !== undefined && Date.parse(m.expiresAt) - now < 60_000;
      const cd = { size: ts, family: fonts.mono, color: soon ? colors.warn : colors.inkDim };
      const cw = left ? kit.drawTracked(g, left, box.x + box.w, top + ts, { ...cd, align: 'right' }) : 0;
      const title = { size: ts, family: fonts.sans, color: on ? colors.ink : colors.inkDim };
      kit.drawTracked(g, kit.truncate(g, m.name, box.w - cw - ts * 0.6, title), box.x, top + ts, title);
      const size = m.vramBytes !== undefined && m.sizeBytes !== undefined && m.vramBytes < m.sizeBytes * 0.98
        ? `${fmtBytes(m.sizeBytes)} (${Math.round((m.vramBytes / m.sizeBytes) * 100)}% GPU)`
        : m.vramBytes !== undefined ? `${fmtBytes(m.vramBytes)} VRAM` : fmtBytes(m.sizeBytes);
      const meta = [options.showServer ? s.name : '', size, m.contextLength ? `ctx ${fmtCtx(m.contextLength)}` : '', m.quantization ?? ''].filter(Boolean).join(' · ');
      const mo = { size: ms, family: fonts.mono, color: colors.inkFaint };
      kit.drawTracked(g, kit.truncate(g, meta, box.w, mo), box.x, top + ts + ms * 1.35, mo);
    });
    if (rows.length > fit) {
      const o = { size: ms, family: fonts.sans, color: colors.inkDim };
      kit.drawTracked(g, `+${rows.length - fit}`, box.x + box.w, box.y + box.h - 2, { ...o, align: 'right' });
    }
  },
  demo,
});

/** Over a threshold: waiting requests or KV cache. */
export function congested(s: ServerStatus, o: { maxWaiting: number; maxKv: number }): boolean {
  return s.reachable && ((s.waiting ?? 0) > o.maxWaiting || (s.kvUsage ?? 0) * 100 > o.maxKv);
}

export const queue = defineWidget({
  id: 'queue',
  name: { en: 'Inference queue', es: 'Cola de inferencia' },
  description: {
    en: 'Requests running and waiting on each server, with its KV cache usage. Turns red when too many wait or the cache is nearly full.',
    es: 'Peticiones en curso y en espera en cada servidor, con el uso de su caché KV. Se pone en rojo si esperan demasiadas o la caché está casi llena.',
  },
  icon: 'layers',
  category: 'dev',
  tags: ['llm', 'vllm', 'llama.cpp', 'ai'],
  size: { min: { w: 220, h: 80 }, preferred: { w: 600, h: 200 } },
  sources: [SOURCE],
  options: t.object({
    maxWaiting: t.integer({ default: 2, min: 0, max: 100, label: { en: 'Alert when more requests wait than', es: 'Avisar si esperan más peticiones que' } }),
    maxKv: t.integer({ default: 90, min: 10, max: 100, unit: '%', slider: true, label: { en: 'Alert when KV cache is above', es: 'Avisar si la caché KV supera' } }),
    takeOver: t.boolean({ default: true, label: { en: 'Take the cell over on alert', es: 'Quedarse la celda al avisar' }, help: { en: 'Marks the widget urgent while a server is over a threshold.', es: 'Marca el widget como urgente mientras un servidor pase un umbral.' } }),
    onlyWithQueue: t.boolean({ default: true, label: { en: 'Only servers that report a queue', es: 'Solo servidores que dan cola' } }),
  }),
  idle: (s) => !anyBusy(s),
  urgent: ({ options, sources }) => options.takeOver && Boolean(dataOf(sources)?.servers.some((s) => congested(s, options))),
  render(g, ctx) {
    const { options, sources, box, theme, kit, t: tr } = ctx;
    const data = dataOf(sources);
    if (!data) return;
    const { colors, fonts } = theme;
    const list = data.servers.filter((s) => !options.onlyWithQueue || !s.reachable || s.running !== undefined || s.kvUsage !== undefined);
    if (!list.length) return message(g, ctx, tr(data.servers.length ? { en: 'No server reports a queue', es: 'Ningún servidor da cola' } : MSG.none));
    const rowH = Math.max(30, Math.min(90, box.h / list.length));
    const fit = Math.max(1, Math.floor(box.h / rowH + 0.1));
    const ts = Math.round(rowH * 0.36);
    list.slice(0, fit).forEach((s, i) => {
      const top = box.y + i * rowH;
      const hot = congested(s, options);
      const on = busy(s);
      const name = { size: ts, family: fonts.sans, color: hot ? colors.alert : on ? colors.ink : colors.inkDim };
      if (!s.reachable) {
        kit.drawTracked(g, s.name, box.x, top + ts, { ...name, color: colors.inkDim });
        kit.drawTracked(g, tr(MSG.down), box.x + box.w, top + ts, { size: ts, family: fonts.sans, color: colors.alert, align: 'right' });
        return;
      }
      const counts = `${s.running ?? '–'} ${tr({ en: 'run', es: 'en curso' })} · ${s.waiting ?? '–'} ${tr({ en: 'wait', es: 'esperan' })}`;
      const co = { size: ts, family: fonts.mono, color: (s.waiting ?? 0) > options.maxWaiting ? colors.alert : on ? colors.info : colors.inkFaint };
      const cw = kit.drawTracked(g, counts, box.x + box.w, top + ts, { ...co, align: 'right' });
      kit.drawTracked(g, kit.truncate(g, s.name, box.w - cw - ts, name), box.x, top + ts, name);
      if (s.kvUsage !== undefined) {
        const kvHot = s.kvUsage * 100 > options.maxKv;
        const by = top + ts * 1.45, bh = Math.max(4, rowH * 0.22);
        const lab = { size: Math.round(bh * 1.1), family: fonts.mono, color: kvHot ? colors.alert : colors.inkDim };
        const lw = kit.drawTracked(g, `KV ${Math.round(s.kvUsage * 100)}%`, box.x + box.w, by + bh, { ...lab, align: 'right' });
        const bw = box.w - lw - ts * 0.5;
        g.fillStyle = colors.surfaceEdge;
        g.fillRect(box.x, by, bw, bh);
        g.fillStyle = kvHot ? colors.alert : on ? colors.info : colors.inkFaint;
        g.fillRect(box.x, by, bw * Math.min(1, Math.max(0, s.kvUsage)), bh);
      }
    });
  },
  demo,
});

export const status = defineWidget({
  id: 'status',
  name: { en: 'LLM servers', es: 'Servidores LLM' },
  description: {
    en: 'One line per server for small panels: up or down, the loaded model and its tokens per second.',
    es: 'Una línea por servidor para pantallas pequeñas: si está activo, el modelo cargado y sus tokens por segundo.',
  },
  icon: 'server',
  category: 'dev',
  tags: ['llm', 'ollama', 'ai'],
  size: { min: { w: 140, h: 40 }, preferred: { w: 320, h: 160 } },
  sources: [SOURCE],
  options: t.object({}),
  idle: (s) => !anyBusy(s),
  render(g, ctx) {
    const { sources, box, theme, kit, t: tr } = ctx;
    const data = dataOf(sources);
    if (!data) return;
    const { colors, fonts } = theme;
    if (!data.servers.length) return message(g, ctx, tr(MSG.none));
    const rowH = Math.max(18, Math.min(48, box.h / data.servers.length));
    const fit = Math.max(1, Math.floor(box.h / rowH + 0.1));
    const s0 = Math.round(rowH * 0.62);
    data.servers.slice(0, fit).forEach((s, i) => {
      const base = box.y + i * rowH + rowH * 0.72;
      const on = busy(s);
      const dot = s0 * 0.26;
      g.fillStyle = !s.reachable ? colors.alert : on ? colors.info : colors.inkFaint;
      g.beginPath();
      g.arc(box.x + dot, base - s0 * 0.33, dot, 0, Math.PI * 2);
      g.fill();
      const x0 = box.x + dot * 3;
      const right = !s.reachable ? tr(MSG.down) : s.genTps !== undefined ? `${fmtTps(s.genTps)} t/s` : '';
      const ro = { size: s0, family: fonts.mono, color: !s.reachable ? colors.alert : on ? colors.ink : colors.inkFaint };
      const rw = right ? kit.drawTracked(g, right, box.x + box.w, base, { ...ro, align: 'right' }) : 0;
      const label = s.models[0] ? `${s.name} · ${s.models[0].name}` : s.name;
      const lo = { size: s0, family: fonts.sans, color: on ? colors.ink : colors.inkDim };
      kit.drawTracked(g, kit.truncate(g, label, box.x + box.w - x0 - rw - s0 * 0.4, lo), x0, base, lo);
    });
  },
  demo,
});

export default definePlugin({
  id: 'llm',
  name: { en: 'Local LLMs', es: 'LLM locales' },
  version: '0.1.0',
  description: { en: 'Tokens per second, loaded models and request queues of your local LLM servers.', es: 'Tokens por segundo, modelos cargados y colas de peticiones de tus servidores de LLM locales.' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'cpu',
  widgets: [throughput, models, queue, status],
  sources: [servers],
});
