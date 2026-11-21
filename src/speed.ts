/**
 * `llm/speed`: tokens per second the way gaming/fps shows frames per second.
 * One server (or one model of it): the generation speed, huge; under it the
 * slow end of the recent answers and the time to first token; beside or
 * under, the speed over the last minutes. Dark while nothing generates: the
 * figures go faint and show the last answers' speed instead of a zero.
 */
import { matchFilter, type Graphics, type Localized, type RenderContext } from '@kiosko/sdk';
import { busy, fmtTps, type LlmData, type ServerStatus } from './llm.ts';

type Ctx = Pick<RenderContext<unknown, unknown>, 'box' | 'theme' | 'kit' | 't' | 'now' | 'fmt'>;
type Level = 'normal' | 'warn' | 'alert';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const fill = (text: string, vars: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
/** CJK glyphs stop being legible under this. */
const MIN_TEXT = 11;

export const SPEED_TEXT = {
  tokS: { en: 'tok/s', es: 'tok/s', de: 'Tok/s', 'zh-Hant': 'tok/s', 'zh-Hans': 'tok/s' },
  gen: { en: 'generating', es: 'generando', de: 'generiert', 'zh-Hant': '生成中', 'zh-Hans': '生成中' },
  // While idle the big figure is the recent answers' speed, not a zero.
  last: { en: 'recently', es: 'recientes', de: 'zuletzt', 'zh-Hant': '最近', 'zh-Hans': '最近' },
  // Like the 1 % low of games: the speed the slowest tenth of the recent answers stay under.
  low: { en: '10% low', es: '10 % bajo', de: '10-%-Tief', 'zh-Hant': '10% 低', 'zh-Hans': '10% 低' },
  ttft: { en: '1st token', es: '1.er token', de: '1. Token', 'zh-Hant': '首個 token', 'zh-Hans': '首 token' },
  curve: { en: 'tok/s · {span}', es: 'tok/s · {span}', de: 'Tok/s · {span}', 'zh-Hant': 'tok/s · {span}', 'zh-Hans': 'tok/s · {span}' },
  peak: { en: 'peak {v}', es: 'máx. {v}', de: 'Spitze {v}', 'zh-Hant': '峰值 {v}', 'zh-Hans': '峰值 {v}' },
  p90: { en: 'p90 {v}', es: 'p90 {v}', de: 'p90 {v}', 'zh-Hant': 'p90 {v}', 'zh-Hans': 'p90 {v}' },
  down: { en: 'down', es: 'caído', de: 'offline', 'zh-Hant': '離線', 'zh-Hans': '离线' },
  noSpeed: {
    en: 'No server reports tokens/s. Ollama and LM Studio: turn on the measuring proxy in the source.',
    es: 'Ningún servidor da tokens/s. Ollama y LM Studio: activa el proxy de medición en la fuente.',
    de: 'Kein Server meldet Tokens/s. Ollama und LM Studio: den Mess-Proxy in der Datenquelle einschalten.',
    'zh-Hant': '沒有伺服器回報 tokens/s。Ollama 與 LM Studio：請在資料來源中開啟測速代理。',
    'zh-Hans': '没有服务器报告 tokens/s。Ollama 和 LM Studio：请在数据源中开启测速代理。',
  },
  noMatch: { en: 'No server or model matches', es: 'Ningún servidor o modelo coincide', de: 'Kein Server oder Modell passt', 'zh-Hant': '沒有符合的伺服器或模型', 'zh-Hans': '没有符合的服务器或模型' },
} satisfies Record<string, Localized>;

export interface SpeedOptions {
  server: string;
  model: string;
  warnBelow: number;
  alertBelow: number;
  historyMs: number;
  showName: boolean;
}

/** What the widget draws: one server, or one model of it. */
export interface SpeedView {
  s: ServerStatus;
  title: string;
  model?: string;
  on: boolean;
  genTps?: number;
  decodeTps?: number;
  lowTps?: number;
  ttftP50?: number;
  ttftP90?: number;
  history: [number, number][];
}

/** A server that says something about its speed. */
export const hasSpeed = (s: ServerStatus) => s.reachable && (s.genTps !== undefined || s.history.length > 0 || s.decodeTps !== undefined);

const lastNonZero = (h: [number, number][]) => {
  for (let i = h.length - 1; i >= 0; i--) if (h[i]![1] > 0.5) return h[i]!;
  return undefined;
};

/**
 * Which server (and model) to show. With no server set: the one generating
 * fastest now, else the one that generated last, else the first with figures.
 */
export function pickSpeed(data: LlmData, o: Pick<SpeedOptions, 'server' | 'model'>): SpeedView | undefined {
  const server = o.server.trim(), model = o.model.trim();
  let list = data.servers.filter((s) => (server ? matchFilter([s.name, s.url], [server]) : true));
  if (server && list.length && !list.some(hasSpeed)) return view(list[0]!, undefined);
  list = list.filter((s) => s.reachable);
  if (model) {
    for (const s of list) {
      const m = s.speeds?.find((x) => matchFilter([x.model], [model]));
      if (m) return view(s, m.model);
    }
    const holder = list.find((s) => s.models.some((x) => matchFilter([x.name], [model])) && hasSpeed(s));
    return holder ? view(holder, undefined, holder.models.find((x) => matchFilter([x.name], [model]))!.name) : undefined;
  }
  const withSpeed = list.filter(hasSpeed);
  if (!withSpeed.length) return undefined;
  const now = [...withSpeed].filter(busy).sort((a, b) => (b.genTps ?? 0) - (a.genTps ?? 0))[0];
  const recent = [...withSpeed].sort((a, b) => (lastNonZero(b.history)?.[0] ?? 0) - (lastNonZero(a.history)?.[0] ?? 0))[0];
  return view(now ?? recent ?? withSpeed[0]!, undefined);
}

function view(s: ServerStatus, speedModel: string | undefined, modelName?: string): SpeedView {
  const m = speedModel ? s.speeds?.find((x) => x.model === speedModel) : undefined;
  const src = m ?? s;
  const genTps = src.genTps;
  const on = s.reachable && (m ? (m.genTps ?? 0) > 0.5 : busy(s));
  const name = m?.model ?? modelName ?? (s.speeds?.length === 1 ? s.speeds[0]!.model : s.models[0]?.name);
  return {
    s,
    title: name ? `${s.name} · ${name}` : s.name,
    ...(m || modelName ? { model: m?.model ?? modelName } : {}),
    on,
    ...(genTps !== undefined ? { genTps } : {}),
    ...(src.decodeTps !== undefined ? { decodeTps: src.decodeTps } : {}),
    ...(src.lowTps !== undefined ? { lowTps: src.lowTps } : {}),
    ...(src.ttftP50 !== undefined ? { ttftP50: src.ttftP50 } : {}),
    ...(src.ttftP90 !== undefined ? { ttftP90: src.ttftP90 } : {}),
    history: m?.history ?? s.history,
  };
}

/** Amber and red under the thresholds (0 = off), only for a speed actually measured. */
export function speedLevel(v: number | undefined, o: Pick<SpeedOptions, 'warnBelow' | 'alertBelow'>): Level {
  if (v === undefined || v <= 0.5) return 'normal';
  if (o.alertBelow > 0 && v < o.alertBelow) return 'alert';
  if (o.warnBelow > 0 && v < o.warnBelow) return 'warn';
  return 'normal';
}

/** The figure the big number shows: live while generating, else the recent answers' speed. */
export function headline(v: SpeedView): { value?: number; live: boolean } {
  if (v.on) return { ...(v.genTps !== undefined ? { value: v.genTps } : {}), live: true };
  const last = v.decodeTps ?? lastNonZero(v.history)?.[1];
  return { ...(last !== undefined ? { value: last } : v.genTps !== undefined ? { value: v.genTps } : {}), live: false };
}

/** "0.34 s", "1.2 s", "12 s", "180 ms". */
export function fmtSeconds(v: number | undefined): string {
  if (v === undefined) return '–';
  if (v < 0.1) return `${Math.round(v * 1000)} ms`;
  return v < 10 ? `${v.toFixed(v < 1 ? 2 : 1)} s` : `${Math.round(v)} s`;
}

const color = (l: Level, c: Ctx['theme']['colors'], normal: string) => (l === 'alert' ? c.alert : l === 'warn' ? c.warn : normal);

function drawMessage(g: Graphics, ctx: Ctx, msg: string): void {
  const { box, kit, theme } = ctx;
  const size = Math.max(MIN_TEXT, Math.round(clamp(box.h / 14, MIN_TEXT, 18)));
  const lines = kit.wrapLines(g, msg, box.w, Math.max(1, Math.floor(box.h / (size * 1.3))), { size, family: theme.fonts.sans });
  lines.forEach((l, i) => kit.drawTracked(g, l, box.x, box.y + size * 1.25 * (i + 1), { size, family: theme.fonts.sans, color: theme.colors.inkFaint }));
}

export function drawSpeed(g: Graphics, ctx: Ctx, data: LlmData | undefined, o: SpeedOptions): void {
  const { box, kit, theme, t } = ctx;
  if (!data) return;
  const v = pickSpeed(data, o);
  if (!v) return drawMessage(g, ctx, t(data.servers.some(hasSpeed) || !data.servers.length ? SPEED_TEXT.noMatch : SPEED_TEXT.noSpeed));
  const c = theme.colors;
  const f = theme.fonts;
  if (!v.s.reachable) {
    const size = Math.max(MIN_TEXT, Math.round(clamp(box.h / 8, MIN_TEXT, 28)));
    kit.drawClipped(g, v.s.name, box.x, box.y + size * 1.2, box.w, { size, family: f.sans, color: c.inkDim });
    kit.drawClipped(g, t(SPEED_TEXT.down), box.x, box.y + size * 2.6, box.w, { size, family: f.sans, color: c.alert });
    return;
  }
  const head = headline(v);
  const big0 = fmtTps(head.value);
  const level = head.live ? speedLevel(head.value, o) : 'normal';
  const lowLevel = speedLevel(v.lowTps, o);
  const bigColor = head.live ? color(level, c, c.ink) : c.inkFaint;
  const lowColor = v.on ? color(lowLevel, c, c.inkDim) : c.inkFaint;

  // A strip too small for a curve: one line.
  if (box.h < 70 || box.w < 150) {
    const rest = [v.lowTps !== undefined ? `${t(SPEED_TEXT.low)} ${fmtTps(v.lowTps)}` : '', v.ttftP50 !== undefined ? fmtSeconds(v.ttftP50) : ''].filter(Boolean).join(' · ');
    const all = `${big0} ${t(SPEED_TEXT.tokS)}${rest ? ` · ${rest}` : ''}`;
    const size = kit.fitSize(g, all, box.w, { size: Math.min(box.h * 0.6, 40), family: f.monoBold }, MIN_TEXT);
    const y = box.y + box.h / 2 + size * 0.36;
    const w = kit.drawTracked(g, big0, box.x, y, { size, family: f.monoBold, color: bigColor });
    kit.drawClipped(g, ` ${t(SPEED_TEXT.tokS)}${rest ? ` · ${rest}` : ''}`, box.x + w, y, box.w - w, { size: Math.max(MIN_TEXT, size * 0.6), family: f.mono, color: lowColor });
    return;
  }

  const wide = box.w >= box.h * 1.45;
  const statW = wide ? clamp(box.h * 1.05, 150, box.w * 0.42) : box.w;
  const statH = wide ? box.h : clamp(box.h * 0.5, 70, box.h - 50);
  const sc = clamp(Math.min(statW / 260, statH / 230), 0.45, 2.2);
  const label = { size: Math.max(MIN_TEXT, Math.round(13 * sc)), family: f.sansBold, tracking: 2 * sc, smallCaps: true, color: c.inkFaint };

  // The server (and model), the big speed, then the low and the first token: one block centred in its room.
  const nameH = o.showName && statH > 110 ? label.size * 1.9 : 0;
  const hasLow = v.lowTps !== undefined || v.ttftP50 !== undefined;
  const bigFit = (statH - nameH) / (0.78 + (hasLow ? 0.2 + 0.36 * 0.78 : 0));
  const big = kit.fitSize(g, big0, statW * 0.62, { size: Math.min(bigFit, 200 * sc), family: f.monoBold, tracking: -1 * sc }, 14);
  const low = Math.max(MIN_TEXT + 2, Math.round(big * 0.36));
  const blockH = nameH + big * 0.78 + (hasLow ? big * 0.2 + low * 0.78 : 0);
  let y = box.y + Math.max(0, (statH - blockH) / 2);
  if (nameH) {
    y += label.size;
    kit.drawClipped(g, v.title, box.x, y, statW, { ...label, color: c.inkDim });
    y += nameH - label.size;
  }
  y += big * 0.78;
  const bw = kit.drawTracked(g, big0, box.x, y, { size: big, family: f.monoBold, tracking: -1 * sc, color: bigColor });
  // Beside it: "tok/s" over "generating" (or "recent answers" while idle).
  const unit = { ...label, size: Math.max(MIN_TEXT, Math.round(big * 0.17)) };
  const ux = box.x + bw + Math.max(6, big * 0.08);
  const uw = Math.max(0, box.x + statW - ux);
  const top = y - big * 0.78;
  kit.drawClipped(g, t(SPEED_TEXT.tokS), ux, top + unit.size * 1.1, uw, { ...unit, smallCaps: false, color: c.inkDim });
  kit.drawClipped(g, t(head.live ? SPEED_TEXT.gen : SPEED_TEXT.last), ux, top + unit.size * 1.1 + label.size * 1.5, uw, label);
  // The first token in the same column, level with the foot of the big figure, when there is room; else after the low.
  let ttftDone = v.ttftP50 === undefined;
  if (!ttftDone && big * 0.78 >= unit.size * 1.1 + label.size * 1.5 + unit.size * 1.2 + label.size * 1.5) {
    kit.drawClipped(g, fmtSeconds(v.ttftP50), ux, y - label.size * 1.5, uw, { size: unit.size, family: f.monoBold, color: v.on ? c.inkDim : c.inkFaint });
    kit.drawClipped(g, t(SPEED_TEXT.ttft), ux, y, uw, label);
    ttftDone = true;
  }
  if (hasLow) {
    y += big * 0.2 + low * 0.78;
    const small = { ...label, size: Math.max(MIN_TEXT, Math.round(low * 0.42)) };
    let x = box.x;
    if (v.lowTps !== undefined) {
      const lw = kit.drawTracked(g, fmtTps(v.lowTps), x, y, { size: low, family: f.monoBold, color: lowColor });
      x += lw + Math.max(6, low * 0.25);
      x += kit.drawClipped(g, t(SPEED_TEXT.low), x, y, Math.max(0, box.x + statW - x), small) + low * 0.6;
    }
    if (!ttftDone) {
      const tt = fmtSeconds(v.ttftP50);
      const need = kit.measureTracked(g, tt, { size: low, family: f.monoBold }) + low * 0.25 + kit.measureTracked(g, t(SPEED_TEXT.ttft), small);
      if (x + need <= box.x + statW) {
        const tw = kit.drawTracked(g, tt, x, y, { size: low, family: f.monoBold, color: v.on ? c.inkDim : c.inkFaint });
        kit.drawClipped(g, t(SPEED_TEXT.ttft), x + tw + Math.max(6, low * 0.25), y, Math.max(0, box.x + statW - x - tw), small);
      }
    }
  }

  // The speed over the last minutes.
  const gap = Math.round(clamp(16 * sc, 8, 28));
  const area = wide ? { x: box.x + statW + gap, y: box.y, w: box.w - statW - gap, h: box.h } : { x: box.x, y: box.y + statH + gap, w: box.w, h: box.h - statH - gap };
  if (area.w >= 60 && area.h >= 30) drawCurve(g, ctx, v, o, area);
}

function drawCurve(g: Graphics, ctx: Ctx, v: SpeedView, o: SpeedOptions, r: { x: number; y: number; w: number; h: number }): void {
  const { kit, theme, t, now } = ctx;
  const c = theme.colors;
  const f = theme.fonts;
  const sc = clamp(Math.min(r.w / 600, r.h / 200), 0.5, 1.8);
  const lbl = { size: Math.max(MIN_TEXT, Math.round(13 * sc)), family: f.sansBold, tracking: 2 * sc, smallCaps: true, color: c.inkFaint };
  const footH = r.h >= 80 ? Math.round(lbl.size * 1.7) : 0;
  const ch = r.h - footH;
  const { x: cx, w: cw } = r;
  g.fillStyle = c.bg;
  g.fillRect(cx, r.y, cw, ch);
  const from = now - o.historyMs;
  const pts = v.history.filter(([tm]) => tm > from);
  const peak = pts.reduce((m, [, x]) => Math.max(m, x), 0);
  const yMax = Math.max(peak * 1.15, o.warnBelow * 1.3, 1);
  const py = (x: number) => r.y + ch - (clamp(x, 0, yMax) / yMax) * (ch - 2);
  const px = (tm: number) => cx + ((tm - from) / o.historyMs) * cw;
  // The thresholds, faint and dashed, with their tok/s.
  g.setLineDash([4, 4]);
  g.lineWidth = 1;
  for (const [tps, col] of [
    [o.warnBelow, c.warn],
    [o.alertBelow, c.alert],
  ] as const) {
    if (!(tps > 0) || tps > yMax) continue;
    const yy = Math.round(py(tps)) + 0.5;
    g.strokeStyle = c.surfaceEdge;
    g.beginPath();
    g.moveTo(cx, yy);
    g.lineTo(cx + cw, yy);
    g.stroke();
    if (ch > 50) kit.drawTracked(g, `${tps}`, cx + cw - 4, yy - 3, { size: MIN_TEXT, family: f.mono, color: col, align: 'right' });
  }
  g.setLineDash([]);
  if (pts.length >= 2) {
    g.save();
    g.beginPath();
    g.rect(cx, r.y, cw, ch);
    g.clip();
    // Area under the curve, faint; the curve, dim (in the accent while generating); slow stretches as bars of their colour.
    g.globalAlpha = 0.45;
    g.fillStyle = c.inkFaint;
    g.beginPath();
    g.moveTo(px(pts[0]![0]), r.y + ch);
    for (const [tm, x] of pts) g.lineTo(px(tm), py(x));
    g.lineTo(px(pts.at(-1)![0]), r.y + ch);
    g.closePath();
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = v.on ? c.info : c.inkDim;
    g.lineWidth = Math.max(1, 1.6 * sc);
    g.lineJoin = 'round';
    g.beginPath();
    pts.forEach(([tm, x], i) => (i ? g.lineTo(px(tm), py(x)) : g.moveTo(px(tm), py(x))));
    g.stroke();
    const step = pts.length > 1 ? (px(pts.at(-1)![0]) - px(pts[0]![0])) / (pts.length - 1) : cw;
    const bar = Math.max(2, Math.min(6 * sc, step));
    for (const [tm, x] of pts) {
      const l = speedLevel(x, o);
      if (l === 'normal') continue;
      g.fillStyle = color(l, c, c.inkDim);
      g.fillRect(Math.round(px(tm) - bar / 2), py(x), Math.ceil(bar), r.y + ch - py(x));
    }
    g.restore();
  }
  g.strokeStyle = c.surfaceEdge;
  g.lineWidth = 1;
  g.strokeRect(cx + 0.5, r.y + 0.5, cw - 1, ch - 1);
  if (footH) {
    const fy = r.y + ch + lbl.size * 1.35;
    const right = [v.ttftP90 !== undefined ? `${t(SPEED_TEXT.ttft)} ${fill(t(SPEED_TEXT.p90), { v: fmtSeconds(v.ttftP90) })}` : '', peak > 0 ? fill(t(SPEED_TEXT.peak), { v: fmtTps(peak) }) : ''].filter(Boolean).join(' · ');
    const rw = right ? kit.drawTracked(g, kit.truncate(g, right, cw * 0.6, lbl), cx + cw, fy, { ...lbl, align: 'right' }) : 0;
    kit.drawClipped(g, fill(t(SPEED_TEXT.curve), { span: ctx.fmt?.duration(o.historyMs, { compact: true }) ?? `${Math.round(o.historyMs / 60_000)} min` }), cx, fy, Math.max(0, cw - rw - 12), lbl);
  }
}
