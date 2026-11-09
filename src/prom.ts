/**
 * A small Prometheus text-format (0.0.4) reader: enough for the /metrics of
 * vLLM, llama.cpp and TGI. Samples keep their labels; helpers sum a family,
 * turn counters into rates between two polls (resets included) and read
 * quantiles from the buckets a histogram gained over the poll window.
 */

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export type Metrics = Sample[];

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+-?\d+)?\s*$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*,?/g;

function num(s: string): number {
  if (s === '+Inf' || s === 'Inf') return Infinity;
  if (s === '-Inf') return -Infinity;
  return Number(s);
}

export function parseProm(text: string): Metrics {
  const out: Metrics = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    if (m[2]) for (const l of m[2].matchAll(LABEL)) labels[l[1]!] = l[2]!.replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1');
    const value = num(m[3]!);
    if (Number.isNaN(value)) continue;
    out.push({ name: m[1]!, labels, value });
  }
  return out;
}

/** Sum of every sample of a family (across labels: models, engines…); undefined when absent. */
export function sum(ms: Metrics, ...names: string[]): number | undefined {
  for (const name of names) {
    const s = ms.filter((x) => x.name === name);
    if (s.length) return s.reduce((a, x) => a + x.value, 0);
  }
  return undefined;
}

/** First label value seen for a family (e.g. model_name). */
export function label(ms: Metrics, name: string, key: string): string | undefined {
  return ms.find((x) => x.name.startsWith(name) && x.labels[key] !== undefined)?.labels[key];
}

/** Per-second rate of a counter between two readings; a drop means a restart, so the new value counts from zero. */
export function counterRate(prev: number | undefined, cur: number | undefined, dtMs: number): number | undefined {
  if (prev === undefined || cur === undefined || dtMs <= 0) return undefined;
  const d = cur >= prev ? cur - prev : cur;
  return d / (dtMs / 1000);
}

/** Cumulative buckets of a histogram family, summed across labels other than `le`: [[le, count], …] sorted by le. */
export function buckets(ms: Metrics, family: string): [number, number][] {
  const by = new Map<number, number>();
  for (const s of ms) if (s.name === `${family}_bucket` && s.labels.le !== undefined) {
    const le = num(s.labels.le);
    by.set(le, (by.get(le) ?? 0) + s.value);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]);
}

/** What a histogram gained between two readings (a reset counts from zero). */
export function bucketDelta(prev: [number, number][] | undefined, cur: [number, number][]): [number, number][] {
  if (!prev?.length) return [];
  const p = new Map(prev);
  const reset = cur.some(([le, c]) => c < (p.get(le) ?? 0));
  return cur.map(([le, c]) => [le, reset ? c : c - (p.get(le) ?? 0)]);
}

/** Prometheus-style histogram_quantile with linear interpolation inside the bucket; undefined with no observations. */
export function quantile(q: number, bs: [number, number][]): number | undefined {
  const total = bs.at(-1)?.[1] ?? 0;
  if (!bs.length || total <= 0) return undefined;
  const rank = q * total;
  let prevLe = 0, prevC = 0;
  for (const [le, c] of bs) {
    if (c >= rank) {
      if (le === Infinity) return prevLe;
      if (c === prevC) return le;
      return prevLe + (le - prevLe) * ((rank - prevC) / (c - prevC));
    }
    prevLe = le;
    prevC = c;
  }
  return prevLe;
}
