import { differenceInCalendarDays, getISODay } from "date-fns";
import type { PreferencesInput, ProcessedActivity } from "./types";
import { isRunLike } from "./processed";
import { formatDistance, type UnitSystem } from "@/lib/units";

function daysUntilLongRun(longDay: number | null, now: Date): number | null {
  if (!longDay) return null;
  const today = getISODay(now);
  if (today === longDay) return 0;
  return (longDay - today + 7) % 7;
}

// Distances stay in km so the client can re-format on a units toggle without
// a server round trip.
export interface StateSummaryParts {
  volumeText: string;
  lastActivity: { distanceKm: number; daysAgo: number } | null;
  daysUntilLongRun: number | null;
}

export function buildStateSummaryParts(
  processed: ProcessedActivity[],
  prefs: PreferencesInput,
  now: Date,
  weeklyTargetMin?: number | null
): StateSummaryParts {
  const cutoff = now.getTime() - 7 * 86_400_000;
  const thisWeek = processed.filter(
    (a) => isRunLike(a.type) && a.date.getTime() >= cutoff
  );
  const runsThisWeek = thisWeek.length;
  const minutesThisWeek = Math.round(
    thisWeek.reduce((sum, a) => sum + a.duration_min, 0)
  );
  const volumeText =
    weeklyTargetMin && weeklyTargetMin > 0
      ? `${minutesThisWeek}/${weeklyTargetMin} min this week`
      : `${runsThisWeek} run${runsThisWeek === 1 ? "" : "s"} this week`;

  const last = processed[0];
  const lastActivity = last
    ? {
        distanceKm: last.distance_km,
        daysAgo: differenceInCalendarDays(now, last.date),
      }
    : null;

  return {
    volumeText,
    lastActivity,
    daysUntilLongRun: daysUntilLongRun(prefs.long_run_day, now),
  };
}

export function renderStateSummary(
  parts: StateSummaryParts,
  units: UnitSystem
): string {
  const out: string[] = [parts.volumeText];

  if (parts.lastActivity) {
    const dist = formatDistance(parts.lastActivity.distanceKm, units, 1);
    const days = parts.lastActivity.daysAgo;
    if (days === 0) out.push(`${dist} today`);
    else if (days === 1) out.push(`${dist} yesterday`);
    else out.push(`${dist} ${days}d ago`);
  }

  const dul = parts.daysUntilLongRun;
  if (dul !== null) {
    if (dul === 0) out.push("long run today");
    else if (dul === 1) out.push("long run tomorrow");
    else out.push(`${dul} days until long run`);
  }

  return out.join(" · ");
}
