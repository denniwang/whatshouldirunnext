import { differenceInCalendarDays, getISODay } from "date-fns";
import type { AthleteState, PreferencesInput, ProcessedActivity } from "./types";
import { isRunLike } from "./processed";
import { DEFAULT_UNITS, formatDistance, type UnitSystem } from "@/lib/units";

function daysUntilLongRun(longDay: number | null, now: Date): number | null {
  if (!longDay) return null;
  const today = getISODay(now);
  if (today === longDay) return 0;
  return (longDay - today + 7) % 7;
}

export function runMinutesThisWeek(
  processed: ProcessedActivity[],
  now: Date
): number {
  const cutoff = now.getTime() - 7 * 86_400_000;
  return processed
    .filter((a) => isRunLike(a.type) && a.date.getTime() >= cutoff)
    .reduce((sum, a) => sum + a.duration_min, 0);
}

export function buildStateSummary(
  processed: ProcessedActivity[],
  state: AthleteState,
  prefs: PreferencesInput,
  now: Date,
  units: UnitSystem = DEFAULT_UNITS,
  weeklyTargetMin?: number | null
): string {
  const parts: string[] = [];

  const cutoff = now.getTime() - 7 * 86_400_000;
  const thisWeek = processed.filter(
    (a) => isRunLike(a.type) && a.date.getTime() >= cutoff
  );
  const runsThisWeek = thisWeek.length;
  const minutesThisWeek = Math.round(
    thisWeek.reduce((sum, a) => sum + a.duration_min, 0)
  );
  if (weeklyTargetMin && weeklyTargetMin > 0) {
    parts.push(`${minutesThisWeek}/${weeklyTargetMin} min this week`);
  } else {
    parts.push(`${runsThisWeek} run${runsThisWeek === 1 ? "" : "s"} this week`);
  }

  const last = processed[0];
  if (last) {
    const days = differenceInCalendarDays(now, last.date);
    const dist = formatDistance(last.distance_km, units, 1);
    if (days === 0) parts.push(`${dist} today`);
    else if (days === 1) parts.push(`${dist} yesterday`);
    else parts.push(`${dist} ${days}d ago`);
  }

  const dul = daysUntilLongRun(prefs.long_run_day, now);
  if (dul !== null) {
    if (dul === 0) parts.push("long run today");
    else if (dul === 1) parts.push("long run tomorrow");
    else parts.push(`${dul} days until long run`);
  }

  return parts.join(" · ");
}
