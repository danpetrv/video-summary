import type { ResolvedProvider } from "./asr/presets";

/** Share of a provider's file limit we plan for: opus output size drifts a little from the bitrate math. */
export const HEADROOM = 0.96;

/** The size a provider is planned against: 96% of its file limit (null = no limit). */
export const usableBytes = (p: ResolvedProvider): number | null => (p.maxBytes === null ? null : Math.floor(HEADROOM * p.maxBytes));

export function targetBytes(ps: ResolvedProvider[]): number | null {
  const caps = ps.filter((p) => !p.local && p.maxBytes !== null).map((p) => p.maxBytes as number);
  return caps.length ? Math.floor(HEADROOM * Math.min(...caps)) : null;
}

export function bitrateFor(durationSec: number | null, mode: "adaptive" | "fixed", target: number | null): number {
  if (mode === "fixed" || target === null || durationSec === null || durationSec <= 0) return 32;
  return Math.min(32, Math.max(16, Math.floor((target * 8) / durationSec / 1000)));
}

export function maxDurationFor(p: ResolvedProvider, kbps: number): number | null {
  const usable = usableBytes(p);
  const byBytes = usable === null ? null : Math.floor((usable * 8) / (kbps * 1000));
  if (byBytes === null) return p.maxSeconds;
  return p.maxSeconds === null ? byBytes : Math.min(p.maxSeconds, byBytes);
}

export type LimitRow = { provider: string; adaptiveSec: number | null; fixedSec: number | null };

export function limitsReport(ps: ResolvedProvider[]): LimitRow[] {
  return ps.map((p) => ({ provider: p.name, adaptiveSec: maxDurationFor(p, 16), fixedSec: maxDurationFor(p, 32) }));
}
