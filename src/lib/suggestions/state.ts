import { differenceInCalendarDays } from "date-fns";
import type { AthleteState, ProcessedActivity, VolumePreference } from "./types";
import { isRunLike } from "./processed";

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function sumDurationWithin(acts: ProcessedActivity[], now: Date, days: number): number {
  const cutoff = now.getTime() - days * 86_400_000;
  return acts
    .filter((a) => a.date.getTime() >= cutoff)
    .reduce((sum, a) => sum + a.duration_min, 0);
}

const MIN_SUGGESTED_MIN = 60;
const MAX_SUGGESTED_MIN = 900;
const STEP_MIN = 15;

function roundToStep(min: number): number {
  return Math.round(min / STEP_MIN) * STEP_MIN;
}

export function suggestWeeklyTargetMinutes(
  weeklyAvgRunMin: number,
  volumePreference: VolumePreference = "maintain"
): number {
  const base = weeklyAvgRunMin > 0 ? weeklyAvgRunMin : 120;
  const factor =
    volumePreference === "build" ? 1.1 : volumePreference === "recover" ? 0.8 : 1.0;
  const raw = base * factor;
  const stepped = roundToStep(raw);
  return Math.max(MIN_SUGGESTED_MIN, Math.min(MAX_SUGGESTED_MIN, stepped));
}

export function computeAthleteState(
  processed: ProcessedActivity[],
  now: Date
): AthleteState {
  const sorted = [...processed].sort((a, b) => b.date.getTime() - a.date.getTime());
  const runs = sorted.filter((a) => isRunLike(a.type));

  const load_7d_min = sumDurationWithin(runs, now, 7);
  const load_28d_min = sumDurationWithin(runs, now, 28);
  const load_28d_weekly_avg = load_28d_min / 4;
  const acwr = load_28d_weekly_avg > 0 ? load_7d_min / load_28d_weekly_avg : 0;

  const lastRun = runs[0];
  const days_since_last_run = lastRun
    ? Math.max(0, differenceInCalendarDays(now, lastRun.date))
    : 999;

  const cutoff28 = now.getTime() - 28 * 86_400_000;
  const runs28 = runs.filter((a) => a.date.getTime() >= cutoff28);
  const longest_run_28d_min = runs28.reduce((m, a) => Math.max(m, a.duration_min), 0);
  const longest_run_28d_km = runs28.reduce((m, a) => Math.max(m, a.distance_km), 0);

  const flatRuns = runs.filter((a) => a.elevation_gain_m < 30 && a.distance_km >= 1);
  const hillyRuns = runs.filter((a) => a.elevation_gain_m > 100 && a.distance_km >= 1);
  const typical_pace_flat: number | null =
    flatRuns.length >= 3 ? median(flatRuns.map((a) => a.pace_sec_per_km)) : null;
  const hillyMedian = hillyRuns.length >= 3 ? median(hillyRuns.map((a) => a.grade_adjusted_pace)) : null;
  const typical_pace_hilly: number | null = hillyMedian ?? typical_pace_flat;

  const oldest_activity_date = sorted.length
    ? sorted[sorted.length - 1]!.date
    : null;

  const suggested_weekly_target_min = suggestWeeklyTargetMinutes(load_28d_weekly_avg);

  const lastActivity = sorted[0];
  const hours_since_last_activity = lastActivity
    ? Math.max(0, (now.getTime() - lastActivity.date.getTime()) / 3_600_000)
    : null;

  const QUALITY_DURATION_TEMPO_MIN = 25;
  const NEVER = 999;
  const hardRuns = runs.filter((a) => a.effort_bucket === "hard");
  const tempoRuns = hardRuns.filter((a) => a.duration_min >= QUALITY_DURATION_TEMPO_MIN);
  const intervalsRuns = hardRuns.filter((a) => a.duration_min < QUALITY_DURATION_TEMPO_MIN);
  const daysSince = (xs: ProcessedActivity[]): number =>
    xs.length === 0
      ? NEVER
      : Math.max(0, differenceInCalendarDays(now, xs[0]!.date));
  const days_since_last_quality_session = daysSince(hardRuns);
  const days_since_last_tempo = daysSince(tempoRuns);
  const days_since_last_intervals = daysSince(intervalsRuns);

  const LONG_RUN_DURATION_MIN = 60;
  const longRuns = runs.filter((a) => a.duration_min >= LONG_RUN_DURATION_MIN);
  const days_since_last_long_run = daysSince(longRuns);

  return {
    load_7d_min,
    load_28d_min,
    load_28d_weekly_avg,
    acwr,
    days_since_last_run,
    longest_run_28d_min,
    longest_run_28d_km,
    typical_pace_flat,
    typical_pace_hilly,
    last_3_activities: sorted.slice(0, 3),
    recent_runs: runs.slice(0, 10),
    hours_since_last_activity,
    total_runs_in_window: runs.length,
    total_activities_in_window: sorted.length,
    oldest_activity_date,
    suggested_weekly_target_min,
    days_since_last_quality_session,
    days_since_last_tempo,
    days_since_last_intervals,
    days_since_last_long_run,
  };
}
