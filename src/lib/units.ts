export type UnitSystem = "metric" | "imperial";

export const UNITS_COOKIE = "units";
export const UNITS_STORAGE_KEY = "wsirn:units";
export const DEFAULT_UNITS: UnitSystem = "metric";

const KM_PER_MILE = 1.609344;
const FT_PER_M = 3.28084;

export function isUnitSystem(v: unknown): v is UnitSystem {
  return v === "metric" || v === "imperial";
}

export function distanceLabel(u: UnitSystem): "km" | "mi" {
  return u === "imperial" ? "mi" : "km";
}

export function paceLabel(u: UnitSystem): "/km" | "/mi" {
  return u === "imperial" ? "/mi" : "/km";
}

export function elevationLabel(u: UnitSystem): "m" | "ft" {
  return u === "imperial" ? "ft" : "m";
}

export function kmToDisplay(km: number, u: UnitSystem): number {
  return u === "imperial" ? km / KM_PER_MILE : km;
}

export function metersToDisplay(m: number, u: UnitSystem): number {
  return u === "imperial" ? m * FT_PER_M : m;
}

export function paceSecPerKmToDisplay(secPerKm: number, u: UnitSystem): number {
  return u === "imperial" ? secPerKm * KM_PER_MILE : secPerKm;
}

export function formatDistance(km: number, u: UnitSystem, digits = 1): string {
  return `${kmToDisplay(km, u).toFixed(digits)}${distanceLabel(u)}`;
}

export function formatDistanceRounded(km: number, u: UnitSystem): string {
  return `${Math.round(kmToDisplay(km, u))}${distanceLabel(u)}`;
}

export function formatElevation(m: number, u: UnitSystem): string {
  return `${Math.round(metersToDisplay(m, u))}${elevationLabel(u)}`;
}

export function formatPace(secPerKm: number, u: UnitSystem, withUnit = true): string {
  if (!secPerKm) return withUnit ? "—" : "";
  const sec = paceSecPerKmToDisplay(secPerKm, u);
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  const base = `${m}:${String(s).padStart(2, "0")}`;
  return withUnit ? `${base}${paceLabel(u)}` : base;
}

// Expand {d:N} (distance in km) and {p:N} / {p:LO-HI} (pace in sec/km) tokens
// in suggestion reason/pace_note strings produced by the engine. The engine is
// unit-agnostic — formatting happens at display time so the units toggle can
// update text instantly without a server round trip.
const REASON_TOKEN_RE = /\{(d|p):([^}]+)\}/g;

export function formatReason(text: string, u: UnitSystem): string {
  return text.replace(REASON_TOKEN_RE, (_, kind: "d" | "p", value: string) => {
    if (kind === "d") {
      const km = Number.parseFloat(value);
      if (!Number.isFinite(km)) return "";
      return formatDistance(km, u, 1);
    }
    const rangeMatch = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(value);
    if (rangeMatch) {
      const lo = Number.parseFloat(rangeMatch[1]!);
      const hi = Number.parseFloat(rangeMatch[2]!);
      return `${formatPace(lo, u, false)}–${formatPace(hi, u, false)}${paceLabel(u)}`;
    }
    const single = Number.parseFloat(value);
    if (!Number.isFinite(single)) return "";
    return formatPace(single, u, true);
  });
}
