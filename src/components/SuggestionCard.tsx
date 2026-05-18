import type { WorkoutSuggestion } from "@/lib/suggestions/types";
import {
  DEFAULT_UNITS,
  formatDistance,
  formatPace,
  paceLabel,
  type UnitSystem,
} from "@/lib/units";

const TYPE_COLOR: Record<WorkoutSuggestion["type"], string> = {
  easy: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  long: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  tempo: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  intervals: "bg-red-500/15 text-red-300 border-red-500/40",
  recovery: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  rest: "bg-zinc-500/15 text-zinc-300 border-zinc-500/40",
  "cross-train": "bg-violet-500/15 text-violet-300 border-violet-500/40",
};

const TYPE_LABEL: Record<WorkoutSuggestion["type"], string> = {
  easy: "easy",
  long: "long",
  tempo: "tempo",
  intervals: "intervals",
  recovery: "recovery",
  rest: "rest",
  "cross-train": "cross-train",
};

function headline(s: WorkoutSuggestion): string {
  if (s.type === "rest") return "Rest day";
  if (s.type === "cross-train") return `Cross-train · ${s.duration_min} min`;
  return `${TYPE_LABEL[s.type]} run · ${s.duration_min} min`;
}

function specifics(s: WorkoutSuggestion, units: UnitSystem): string | null {
  if (s.type === "rest") return null;
  if (s.type === "cross-train") return s.terrain !== "any" ? `${s.terrain}` : "yoga · bike · walk · mobility";
  const parts: string[] = [];
  if (s.pace_target_low && s.pace_target_high) {
    const lo = formatPace(s.pace_target_low, units, false);
    const hi = formatPace(s.pace_target_high, units, false);
    parts.push(`Target ${lo}–${hi}${paceLabel(units)}`);
  }
  if (s.distance_km_estimate > 0) {
    parts.push(`~${formatDistance(s.distance_km_estimate, units, 1)}`);
  }
  if (s.terrain !== "any") parts.push(s.terrain);
  return parts.join(" · ");
}

export function SuggestionCard({
  s,
  units = DEFAULT_UNITS,
  compact = false,
}: {
  s: WorkoutSuggestion;
  units?: UnitSystem;
  compact?: boolean;
}) {
  const spec = specifics(s, units);
  const isTomorrow = s.for_when === "tomorrow";
  return (
    <article className={compact ? "card border-[var(--border)]/70 bg-[var(--card)]/60" : "card"}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {isTomorrow && (
            <span className="rounded-full border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-sky-300">
              Tomorrow
            </span>
          )}
          <h3 className="text-base font-semibold leading-tight">{headline(s)}</h3>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${TYPE_COLOR[s.type]}`}
        >
          {TYPE_LABEL[s.type]}
        </span>
      </div>
      {spec && <p className="mt-1 text-xs text-[var(--muted)]">{spec}</p>}
      <p className="mt-3 text-sm text-[var(--muted)]">{s.reason}</p>
    </article>
  );
}
