import { getISODay, differenceInCalendarDays, format } from "date-fns";
import type {
  AthleteState,
  PreferencesInput,
  ProcessedActivity,
  WorkoutSuggestion,
  WorkoutType,
} from "./types";
import { isRunLike } from "./processed";

const DEFAULT_TYPICAL_PACE = 360;
const MIN_PACE = 240;
const MAX_PACE = 540;

function clampPace(p: number): number {
  return Math.max(MIN_PACE, Math.min(MAX_PACE, Math.round(p)));
}

function paceRange(typical: number, lowOffset: number, highOffset: number) {
  const t = typical > 0 ? typical : DEFAULT_TYPICAL_PACE;
  return {
    pace_target_low: clampPace(t + lowOffset),
    pace_target_high: clampPace(t + highOffset),
  };
}

function distanceEstimate(durationMin: number, paceLow: number, paceHigh: number): number {
  if (durationMin <= 0) return 0;
  const avgPace = (paceLow + paceHigh) / 2;
  if (avgPace <= 0) return 0;
  return +(durationMin * 60 / avgPace).toFixed(1);
}

function formatPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatKm(km: number): string {
  return `${km.toFixed(1)}km`;
}

function refDateLabel(refDate: Date, now: Date): string {
  const days = differenceInCalendarDays(now, refDate);
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days <= 6) return format(refDate, "EEEE");
  return `${days} days ago`;
}

function findReferenceRun(
  state: AthleteState,
  type: WorkoutType,
  targetDistanceKm: number
): ProcessedActivity | null {
  const runs = state.recent_runs;
  if (runs.length === 0) return null;
  if (type === "easy" || type === "recovery") {
    const easies = runs.filter((r) => r.effort_bucket === "easy" && r.distance_km >= 1);
    if (easies.length === 0) return null;
    return [...easies].sort(
      (a, b) =>
        Math.abs(a.distance_km - targetDistanceKm) -
        Math.abs(b.distance_km - targetDistanceKm)
    )[0]!;
  }
  if (type === "tempo" || type === "intervals") {
    const hards = runs.filter((r) => r.effort_bucket === "hard");
    return hards[0] ?? null;
  }
  if (type === "long") {
    const sortedByDuration = [...runs].sort((a, b) => b.duration_min - a.duration_min);
    return sortedByDuration[0] ?? null;
  }
  return null;
}

export interface RuleContext {
  state: AthleteState;
  prefs: PreferencesInput;
  now: Date;
  todayISO: number;
  hoursSinceLastActivity: number | null;
  recentlyTrained: boolean;
}

export interface RuleCandidate extends WorkoutSuggestion {
  source: string;
}

function recoveryOverrideTriggered(ctx: RuleContext): {
  hit: boolean;
  why: "yesterday_hard" | "acwr" | "injury" | null;
  lastActivity?: ProcessedActivity;
} {
  const { state, prefs, now } = ctx;
  const last = state.last_3_activities[0];
  if (last) {
    const hoursAgo = (now.getTime() - last.date.getTime()) / 3_600_000;
    if (hoursAgo <= 24 && (last.duration_min > 90 || last.effort_bucket === "hard")) {
      return { hit: true, why: "yesterday_hard", lastActivity: last };
    }
  }
  if (
    state.acwr > 1.5 &&
    state.total_runs_in_window >= 3 &&
    state.load_7d_min >= 180 &&
    state.load_28d_min >= 240
  ) {
    return { hit: true, why: "acwr" };
  }
  const hasInjury =
    prefs.bothering.length > 0 && !prefs.bothering.includes("none");
  if (hasInjury) {
    return { hit: true, why: "injury" };
  }
  return { hit: false, why: null };
}

function inTaperWindow(ctx: RuleContext): boolean {
  if (ctx.prefs.goal !== "race" || !ctx.prefs.race_date) return false;
  const days = differenceInCalendarDays(ctx.prefs.race_date, ctx.now);
  return days >= 0 && days <= 14;
}

function ruleRecovery(ctx: RuleContext): RuleCandidate[] {
  const trig = recoveryOverrideTriggered(ctx);
  if (!trig.hit) return [];
  const { state, prefs } = ctx;
  const out: RuleCandidate[] = [];

  const hasInjury =
    prefs.bothering.length > 0 && !prefs.bothering.includes("none");
  const range = paceRange(state.typical_pace_flat, 45, 75);

  let reason: string;
  if (trig.why === "yesterday_hard" && trig.lastActivity) {
    const km = formatKm(trig.lastActivity.distance_km);
    if (ctx.recentlyTrained && ctx.hoursSinceLastActivity !== null) {
      const h = Math.max(1, Math.round(ctx.hoursSinceLastActivity));
      reason = `You ran ${km} ${h} hour${h === 1 ? "" : "s"} ago — tomorrow keep it easy at ${formatPace(range.pace_target_low)}–${formatPace(range.pace_target_high)}/km.`;
    } else {
      reason = `You ran ${km} yesterday — keep today easy to recover.`;
    }
  } else if (trig.why === "acwr") {
    reason = "You've been ramping up fast this week. Take it easy.";
  } else {
    reason = "Injury flag set — recovery and mobility today, no hard efforts.";
  }

  out.push({
    type: "recovery",
    duration_min: 25,
    distance_km_estimate: distanceEstimate(25, range.pace_target_low, range.pace_target_high),
    pace_target_low: range.pace_target_low,
    pace_target_high: range.pace_target_high,
    terrain: "flat",
    reason,
    priority: 1,
    source: "recovery",
  });

  if (hasInjury) {
    out.push({
      type: "rest",
      duration_min: 0,
      distance_km_estimate: 0,
      pace_target_low: 0,
      pace_target_high: 0,
      terrain: "any",
      reason: "Take a full rest day while the niggle settles.",
      priority: 2,
      source: "recovery-rest",
    });
  }
  return out;
}

function pickLongReason(ctx: RuleContext): string {
  const ref = findReferenceRun(ctx.state, "long", 0);
  if (ref && ref.duration_min >= 50) {
    return `Build on your ${formatKm(ref.distance_km)} run from ${refDateLabel(ref.date, ctx.now)} — same easy effort, more time on feet.`;
  }
  return "Build endurance with your longest run of the week.";
}

function ruleLongRun(ctx: RuleContext, recoveryFired: boolean): RuleCandidate[] {
  if (recoveryFired) return [];
  const { state, prefs, todayISO } = ctx;
  if (!prefs.long_run_day || prefs.long_run_day !== todayISO) return [];

  const baseMin = state.longest_run_28d_min > 0 ? state.longest_run_28d_min : 60;
  const target = Math.min(baseMin * 1.1, baseMin + 15);
  const duration = Math.max(45, Math.round(target));
  const range = paceRange(state.typical_pace_flat, 15, 30);
  const reason = pickLongReason(ctx);
  const primary: RuleCandidate = {
    type: "long",
    duration_min: duration,
    distance_km_estimate: distanceEstimate(duration, range.pace_target_low, range.pace_target_high),
    pace_target_low: range.pace_target_low,
    pace_target_high: range.pace_target_high,
    terrain: "rolling",
    reason,
    priority: 1,
    source: "long-run",
  };

  const shortDuration = Math.max(40, duration - 20);
  const shortRange = paceRange(state.typical_pace_flat, 10, 25);
  const shortVariant: RuleCandidate = {
    type: "long",
    duration_min: shortDuration,
    distance_km_estimate: distanceEstimate(shortDuration, shortRange.pace_target_low, shortRange.pace_target_high),
    pace_target_low: shortRange.pace_target_low,
    pace_target_high: shortRange.pace_target_high,
    terrain: "flat",
    reason: "Shorter long-run option if today's time is tight — same conversational effort, flatter route.",
    priority: 5,
    source: "long-run-short",
  };

  return [primary, shortVariant];
}

function pickTempoReason(
  ctx: RuleContext,
  range: { pace_target_low: number; pace_target_high: number },
  taper: boolean
): string {
  if (taper) return "Short tempo to stay sharp into race week.";
  const ref = findReferenceRun(ctx.state, "tempo", 0);
  if (ref) {
    return `Push like your ${formatKm(ref.distance_km)} on ${refDateLabel(ref.date, ctx.now)} — controlled but pressed, around ${formatPace(range.pace_target_low)}/km.`;
  }
  return `Tempo: 10-15 sec/km faster than your typical pace (${formatPace(ctx.state.typical_pace_flat || DEFAULT_TYPICAL_PACE)}/km).`;
}

function ruleQualitySession(ctx: RuleContext, recoveryFired: boolean): RuleCandidate[] {
  if (recoveryFired) return [];
  const { state, prefs } = ctx;
  if (prefs.goal !== "race") return [];
  const yesterday = state.last_3_activities[0];
  if (yesterday) {
    const hoursAgo = (ctx.now.getTime() - yesterday.date.getTime()) / 3_600_000;
    if (hoursAgo <= 36 && yesterday.effort_bucket === "hard") return [];
  }
  const taper = inTaperWindow(ctx);

  const dist = prefs.race_distance;
  if (dist === "5k" || dist === "10k") {
    const duration = taper ? 15 : 25;
    const range = paceRange(state.typical_pace_flat, -15, -10);
    return [
      {
        type: "tempo",
        duration_min: duration,
        distance_km_estimate: distanceEstimate(duration, range.pace_target_low, range.pace_target_high),
        pace_target_low: range.pace_target_low,
        pace_target_high: range.pace_target_high,
        terrain: "flat",
        reason: pickTempoReason(ctx, range, taper),
        priority: 2,
        source: "quality-tempo",
      },
    ];
  }
  if (dist === "half" || dist === "marathon") {
    const duration = taper ? 25 : 35;
    const range = paceRange(state.typical_pace_flat, -15, -5);
    return [
      {
        type: "tempo",
        duration_min: duration,
        distance_km_estimate: distanceEstimate(duration, range.pace_target_low, range.pace_target_high),
        pace_target_low: range.pace_target_low,
        pace_target_high: range.pace_target_high,
        terrain: "flat",
        reason: taper
          ? "Reduced tempo block to maintain edge without taxing the taper."
          : pickTempoReason(ctx, range, taper),
        priority: 2,
        source: "quality-tempo-long",
      },
    ];
  }
  if (dist === "ultra") {
    const duration = taper ? 45 : 75;
    const range = paceRange(state.typical_pace_hilly || state.typical_pace_flat, 10, 30);
    return [
      {
        type: "long",
        duration_min: duration,
        distance_km_estimate: distanceEstimate(duration, range.pace_target_low, range.pace_target_high),
        pace_target_low: range.pace_target_low,
        pace_target_high: range.pace_target_high,
        terrain: "hilly",
        reason: "Time on feet — find a hilly route and keep effort conversational.",
        priority: 2,
        source: "quality-ultra",
      },
    ];
  }
  return [];
}

function easyDuration(state: AthleteState): number {
  const sessionsPerWeek = 4;
  const target = state.load_28d_weekly_avg > 0
    ? state.load_28d_weekly_avg / sessionsPerWeek
    : 35;
  return Math.max(30, Math.min(50, Math.round(target)));
}

function pickEasyReason(
  ctx: RuleContext,
  range: { pace_target_low: number; pace_target_high: number },
  distEstimate: number
): string {
  const { state, now } = ctx;
  const last = state.last_3_activities[0];

  if (ctx.recentlyTrained && last && isRunLike(last.type) && ctx.hoursSinceLastActivity !== null) {
    const km = formatKm(last.distance_km);
    const h = Math.max(1, Math.round(ctx.hoursSinceLastActivity));
    return `You ran ${km} ${h} hour${h === 1 ? "" : "s"} ago — tomorrow keep it easy at ${formatPace(range.pace_target_low)}–${formatPace(range.pace_target_high)}/km.`;
  }

  const ref = findReferenceRun(state, "easy", distEstimate);
  if (ref) {
    return `Match the effort of your ${formatKm(ref.distance_km)} run on ${refDateLabel(ref.date, now)} — same conversational feel, try ${formatPace(range.pace_target_low)}–${formatPace(range.pace_target_high)}/km.`;
  }

  if (last && isRunLike(last.type) && last.effort_bucket === "hard") {
    const days = Math.max(1, differenceInCalendarDays(now, last.date));
    return days === 1
      ? "Day after your last hard session — flush the legs."
      : `${days} days after your last hard session — flush the legs.`;
  }
  if (state.load_7d_min < state.load_28d_weekly_avg * 0.7 && state.load_28d_weekly_avg > 0) {
    const gap = Math.max(0, Math.round(state.load_28d_weekly_avg - state.load_7d_min));
    return `You're ${gap} min below your weekly average — solid easy run fits.`;
  }
  return "Aerobic base run at conversational effort.";
}

function ruleEasyDefault(ctx: RuleContext, recoveryFired: boolean): RuleCandidate[] {
  if (recoveryFired) return [];
  const { state } = ctx;
  const duration = easyDuration(state);
  const range = paceRange(state.typical_pace_flat, 10, 20);
  const distKm = distanceEstimate(duration, range.pace_target_low, range.pace_target_high);
  const reason = pickEasyReason(ctx, range, distKm);

  const primary: RuleCandidate = {
    type: "easy",
    duration_min: duration,
    distance_km_estimate: distKm,
    pace_target_low: range.pace_target_low,
    pace_target_high: range.pace_target_high,
    terrain: "any",
    reason,
    priority: 3,
    source: "easy-default",
  };

  const longerDuration = Math.min(60, duration + 15);
  const longerRange = paceRange(state.typical_pace_flat, 15, 30);
  const longerDist = distanceEstimate(longerDuration, longerRange.pace_target_low, longerRange.pace_target_high);
  const longerVariant: RuleCandidate = {
    type: "easy",
    duration_min: longerDuration,
    distance_km_estimate: longerDist,
    pace_target_low: longerRange.pace_target_low,
    pace_target_high: longerRange.pace_target_high,
    terrain: "rolling",
    reason: "Or extend it — same conversational effort, on a rolling route.",
    priority: 6,
    source: "easy-rolling",
  };

  const shorterDuration = Math.max(20, duration - 10);
  const shorterRange = paceRange(state.typical_pace_flat, 15, 25);
  const shorterDist = distanceEstimate(shorterDuration, shorterRange.pace_target_low, shorterRange.pace_target_high);
  const shorterVariant: RuleCandidate = {
    type: "easy",
    duration_min: shorterDuration,
    distance_km_estimate: shorterDist,
    pace_target_low: shorterRange.pace_target_low,
    pace_target_high: shorterRange.pace_target_high,
    terrain: "flat",
    reason: "Or trim it — quick shake-out at the same easy effort.",
    priority: 7,
    source: "easy-short",
  };

  const stridesRange = paceRange(state.typical_pace_flat, 5, 15);
  const stridesDist = distanceEstimate(duration, stridesRange.pace_target_low, stridesRange.pace_target_high);
  const stridesVariant: RuleCandidate = {
    type: "easy",
    duration_min: duration,
    distance_km_estimate: stridesDist,
    pace_target_low: stridesRange.pace_target_low,
    pace_target_high: stridesRange.pace_target_high,
    terrain: "flat",
    reason: "Easy run + 4-6 x 20-30s strides at the end — touch some speed without taxing the legs.",
    priority: 8,
    source: "easy-strides",
  };

  const trailDuration = Math.min(60, duration + 5);
  const trailBase = state.typical_pace_hilly > 0 ? state.typical_pace_hilly : state.typical_pace_flat + 30;
  const trailRange = paceRange(trailBase, 20, 40);
  const trailDist = distanceEstimate(trailDuration, trailRange.pace_target_low, trailRange.pace_target_high);
  const trailVariant: RuleCandidate = {
    type: "easy",
    duration_min: trailDuration,
    distance_km_estimate: trailDist,
    pace_target_low: trailRange.pace_target_low,
    pace_target_high: trailRange.pace_target_high,
    terrain: "hilly",
    reason: "Take it to the trails or hills — softer surface, climbs do the work, keep effort honest.",
    priority: 8,
    source: "easy-trail",
  };

  return [primary, longerVariant, shorterVariant, stridesVariant, trailVariant];
}

function ruleCrossOrRest(ctx: RuleContext, recoveryFired: boolean): RuleCandidate[] {
  if (recoveryFired) return [];
  const { state, prefs } = ctx;
  const out: RuleCandidate[] = [];

  if (state.days_since_last_run === 0) {
    out.push({
      type: "cross-train",
      duration_min: 30,
      distance_km_estimate: 0,
      pace_target_low: 0,
      pace_target_high: 0,
      terrain: "any",
      reason: "You already ran today — yoga, easy bike, or a brisk walk fits the gap.",
      priority: 4,
      source: "cross-already-ran",
    });
  }

  if (prefs.volume_preference === "recover" && state.load_7d_min > 0.8 * state.load_28d_weekly_avg) {
    out.push({
      type: "rest",
      duration_min: 0,
      distance_km_estimate: 0,
      pace_target_low: 0,
      pace_target_high: 0,
      terrain: "any",
      reason: "Recovery week — sit this one out and let adaptations land.",
      priority: 4,
      source: "rest-recover-pref",
    });
  }

  return out;
}

function ruleAlternativeOptions(): RuleCandidate[] {
  return [
    {
      type: "cross-train",
      duration_min: 45,
      distance_km_estimate: 0,
      pace_target_low: 0,
      pace_target_high: 0,
      terrain: "any",
      reason: "Easy bike or swim — same aerobic stimulus, zero impact.",
      priority: 9,
      source: "alt-cross-bike",
    },
    {
      type: "cross-train",
      duration_min: 30,
      distance_km_estimate: 0,
      pace_target_low: 0,
      pace_target_high: 0,
      terrain: "any",
      reason: "Strength + mobility — hips, glutes, core. Builds what running can't.",
      priority: 10,
      source: "alt-cross-strength",
    },
    {
      type: "rest",
      duration_min: 0,
      distance_km_estimate: 0,
      pace_target_low: 0,
      pace_target_high: 0,
      terrain: "any",
      reason: "Take it fully off — adaptation happens between sessions.",
      priority: 11,
      source: "alt-rest",
    },
  ];
}

export function generateCandidates(
  state: AthleteState,
  prefs: PreferencesInput,
  now: Date
): RuleCandidate[] {
  const hoursSinceLastActivity = state.hours_since_last_activity;
  const recentlyTrained =
    hoursSinceLastActivity !== null && hoursSinceLastActivity < 12;
  const ctx: RuleContext = {
    state,
    prefs,
    now,
    todayISO: getISODay(now),
    hoursSinceLastActivity,
    recentlyTrained,
  };

  const recovery = ruleRecovery(ctx);
  const recoveryFired = recovery.length > 0;

  return [
    ...recovery,
    ...ruleLongRun(ctx, recoveryFired),
    ...ruleQualitySession(ctx, recoveryFired),
    ...ruleEasyDefault(ctx, recoveryFired),
    ...ruleCrossOrRest(ctx, recoveryFired),
    ...ruleAlternativeOptions(),
  ];
}

export const __testing = {
  recoveryOverrideTriggered,
  inTaperWindow,
  paceRange,
  formatPace,
  formatKm,
  easyDuration,
  findReferenceRun,
  refDateLabel,
};
