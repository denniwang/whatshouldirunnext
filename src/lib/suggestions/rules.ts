import {
  getISODay,
  differenceInCalendarDays,
  format,
  startOfISOWeek,
} from "date-fns";
import type {
  AthleteState,
  PaceRange,
  PreferencesInput,
  ProcessedActivity,
  WorkoutSuggestion,
  WorkoutType,
} from "./types";
import { isRunLike } from "./processed";

const MIN_PACE = 240;
const MAX_PACE = 540;

export const PACE_NOTE_BOOTSTRAP =
  "We'll dial in pace targets once you've logged a few runs";

function clampPace(p: number): number {
  return Math.max(MIN_PACE, Math.min(MAX_PACE, Math.round(p)));
}

function paceRange(
  typical: number | null,
  lowOffset: number,
  highOffset: number
): PaceRange | null {
  if (typical === null || typical <= 0) return null;
  return {
    low: clampPace(typical + lowOffset),
    high: clampPace(typical + highOffset),
  };
}

function distanceEstimate(durationMin: number, range: PaceRange | null): number {
  if (durationMin <= 0) return 0;
  if (!range) return 0;
  const avgPace = (range.low + range.high) / 2;
  if (avgPace <= 0) return 0;
  return +(durationMin * 60 / avgPace).toFixed(1);
}

function paceFields(
  range: PaceRange | null
): { pace_range: PaceRange | null; pace_note?: string } {
  return range
    ? { pace_range: range }
    : { pace_range: null, pace_note: PACE_NOTE_BOOTSTRAP };
}

// Distance and pace inside reason strings are emitted as tokens —
// `{d:N}` for distance in km, `{p:N}` or `{p:LO-HI}` for pace in sec/km.
// `formatReason()` in `@/lib/units` expands them at render time using the
// viewer's chosen unit system.
function distToken(km: number): string {
  return `{d:${km.toFixed(1)}}`;
}

function paceToken(secPerKm: number): string {
  return `{p:${Math.round(secPerKm)}}`;
}

function paceRangeToken(low: number, high: number): string {
  return `{p:${Math.round(low)}-${Math.round(high)}}`;
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
  tier_break: number;
}

export const TIER_BREAK_BY_TYPE: Record<WorkoutType, number> = {
  recovery: 0,
  long: 1,
  tempo: 2,
  intervals: 2,
  easy: 3,
  "cross-train": 4,
  rest: 5,
};

export function tierBreakFor(type: WorkoutType): number {
  return TIER_BREAK_BY_TYPE[type];
}

export function compareCandidates(a: RuleCandidate, b: RuleCandidate): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.tier_break - b.tier_break;
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

export function inRaceWeek(ctx: RuleContext): boolean {
  if (ctx.prefs.goal !== "race" || !ctx.prefs.race_date) return false;
  const days = differenceInCalendarDays(ctx.prefs.race_date, ctx.now);
  return days >= 0 && days <= 7;
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
    const dist = distToken(trig.lastActivity.distance_km);
    if (ctx.recentlyTrained && ctx.hoursSinceLastActivity !== null) {
      const h = Math.max(1, Math.round(ctx.hoursSinceLastActivity));
      reason = range
        ? `You ran ${dist} ${h} hour${h === 1 ? "" : "s"} ago — tomorrow keep it easy at ${paceRangeToken(range.low, range.high)}.`
        : `You ran ${dist} ${h} hour${h === 1 ? "" : "s"} ago — keep tomorrow conversational.`;
    } else {
      reason = `You ran ${dist} yesterday — keep today easy to recover.`;
    }
  } else if (trig.why === "acwr") {
    reason = "You've been ramping up fast this week. Take it easy.";
  } else {
    reason = "Injury flag set — recovery and mobility today, no hard efforts.";
  }

  out.push({
    type: "recovery",
    duration_min: 25,
    distance_km_estimate: distanceEstimate(25, range),
    ...paceFields(range),
    terrain: "flat",
    reason,
    priority: 1,
    source: "recovery",
    tier_break: tierBreakFor("recovery"),
  });

  if (hasInjury) {
    out.push({
      type: "rest",
      duration_min: 0,
      distance_km_estimate: 0,
      pace_range: null,
      terrain: "any",
      reason: "Take a full rest day while the niggle settles.",
      priority: 2,
      source: "recovery-rest",
      tier_break: tierBreakFor("rest"),
    });
  }
  return out;
}

function pickLongReason(ctx: RuleContext): string {
  const ref = findReferenceRun(ctx.state, "long", 0);
  if (ref && ref.duration_min >= 50) {
    return `Build on your ${distToken(ref.distance_km)} run from ${refDateLabel(ref.date, ctx.now)} — same easy effort, more time on feet.`;
  }
  return "Build endurance with your longest run of the week.";
}

const LONG_RUN_GUARD_DAYS_PREFERRED = 5;
const LONG_RUN_GUARD_DAYS_CATCHUP = 6;
const LONG_RUN_DURATION_MIN = 60;

function longRunInCurrentISOWeek(state: AthleteState, now: Date): boolean {
  const weekStart = startOfISOWeek(now).getTime();
  return state.recent_runs.some(
    (r) => r.duration_min >= LONG_RUN_DURATION_MIN && r.date.getTime() >= weekStart
  );
}

function ruleLongRun(ctx: RuleContext, recoveryFired: boolean): RuleCandidate[] {
  if (recoveryFired) return [];
  const { state, prefs, todayISO, now } = ctx;
  if (!prefs.long_run_day) return [];

  const onPreferredDay = prefs.long_run_day === todayISO;
  const preferredDayPassed = todayISO > prefs.long_run_day;
  const wokeNoLongRunThisWeek = !longRunInCurrentISOWeek(state, now);

  const firesOnPreferredDay =
    onPreferredDay && state.days_since_last_long_run >= LONG_RUN_GUARD_DAYS_PREFERRED;

  const firesAsCatchUp =
    !onPreferredDay &&
    preferredDayPassed &&
    wokeNoLongRunThisWeek &&
    state.days_since_last_long_run >= LONG_RUN_GUARD_DAYS_CATCHUP;

  if (!firesOnPreferredDay && !firesAsCatchUp) return [];

  const baseMin = state.longest_run_28d_min > 0 ? state.longest_run_28d_min : 60;
  const target = Math.min(baseMin * 1.1, baseMin + 15);
  const duration = Math.max(45, Math.round(target));
  const range = paceRange(state.typical_pace_flat, 15, 30);
  const baseReason = pickLongReason(ctx);
  const reason = firesAsCatchUp
    ? `Catch-up long run: you didn't get one in on day ${prefs.long_run_day} — slot it in today. ${baseReason}`
    : baseReason;
  const primary: RuleCandidate = {
    type: "long",
    duration_min: duration,
    distance_km_estimate: distanceEstimate(duration, range),
    ...paceFields(range),
    terrain: "rolling",
    reason,
    priority: 1,
    source: "long-run",
    tier_break: tierBreakFor("long"),
  };

  const shortDuration = Math.max(40, duration - 20);
  const shortRange = paceRange(state.typical_pace_flat, 10, 25);
  const shortVariant: RuleCandidate = {
    type: "long",
    duration_min: shortDuration,
    distance_km_estimate: distanceEstimate(shortDuration, shortRange),
    ...paceFields(shortRange),
    terrain: "flat",
    reason: "Shorter long-run option if today's time is tight — same conversational effort, flatter route.",
    priority: 5,
    source: "long-run-short",
    tier_break: tierBreakFor("long"),
  };

  return [primary, shortVariant];
}

function pickTempoReason(
  ctx: RuleContext,
  range: PaceRange | null,
  taper: boolean
): string {
  if (taper) return "Short tempo to stay sharp into race week.";
  const ref = findReferenceRun(ctx.state, "tempo", 0);
  if (ref && range) {
    return `Push like your ${distToken(ref.distance_km)} on ${refDateLabel(ref.date, ctx.now)} — controlled but pressed, around ${paceToken(range.low)}.`;
  }
  if (ref) {
    return `Push like your ${distToken(ref.distance_km)} on ${refDateLabel(ref.date, ctx.now)} — controlled but pressed.`;
  }
  if (range) {
    return `Tempo: ${paceRangeToken(range.low, range.high)} — controlled but pressed.`;
  }
  return "Tempo: controlled but pressed, comfortably uncomfortable. Pace targets will sharpen once you've logged more runs.";
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
  // Taper-aware duration shrinking is centralized in engine.ts (taperScalar).
  // Do not multiply duration here — it would double-scale.
  const taper = inTaperWindow(ctx);

  const dist = prefs.race_distance;
  if (dist === "5k" || dist === "10k") {
    const duration = 25;
    const range = paceRange(state.typical_pace_flat, -15, -10);
    return [
      {
        type: "tempo",
        duration_min: duration,
        distance_km_estimate: distanceEstimate(duration, range),
        ...paceFields(range),
        terrain: "flat",
        reason: pickTempoReason(ctx, range, taper),
        priority: 2,
        source: "quality-tempo",
        tier_break: tierBreakFor("tempo"),
      },
    ];
  }
  if (dist === "half" || dist === "marathon") {
    const duration = 35;
    const range = paceRange(state.typical_pace_flat, -15, -5);
    return [
      {
        type: "tempo",
        duration_min: duration,
        distance_km_estimate: distanceEstimate(duration, range),
        ...paceFields(range),
        terrain: "flat",
        reason: taper
          ? "Tempo block to maintain edge into the taper — engine will trim duration to fit race week."
          : pickTempoReason(ctx, range, taper),
        priority: 2,
        source: "quality-tempo-long",
        tier_break: tierBreakFor("tempo"),
      },
    ];
  }
  if (dist === "ultra") {
    const duration = 75;
    const hillyOrFlat = state.typical_pace_hilly ?? state.typical_pace_flat;
    const range = paceRange(hillyOrFlat, 10, 30);
    return [
      {
        type: "long",
        duration_min: duration,
        distance_km_estimate: distanceEstimate(duration, range),
        ...paceFields(range),
        terrain: "hilly",
        reason: "Time on feet — find a hilly route and keep effort conversational.",
        priority: 2,
        source: "quality-ultra",
        tier_break: tierBreakFor("long"),
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
  range: PaceRange | null,
  distEstimate: number
): string {
  const { state, now } = ctx;
  const last = state.last_3_activities[0];

  if (ctx.recentlyTrained && last && isRunLike(last.type) && ctx.hoursSinceLastActivity !== null) {
    const dist = distToken(last.distance_km);
    const h = Math.max(1, Math.round(ctx.hoursSinceLastActivity));
    return range
      ? `You ran ${dist} ${h} hour${h === 1 ? "" : "s"} ago — tomorrow keep it easy at ${paceRangeToken(range.low, range.high)}.`
      : `You ran ${dist} ${h} hour${h === 1 ? "" : "s"} ago — tomorrow keep it conversational.`;
  }

  const ref = findReferenceRun(state, "easy", distEstimate);
  if (ref && range) {
    return `Match the effort of your ${distToken(ref.distance_km)} run on ${refDateLabel(ref.date, now)} — same conversational feel, try ${paceRangeToken(range.low, range.high)}.`;
  }
  if (ref) {
    return `Match the effort of your ${distToken(ref.distance_km)} run on ${refDateLabel(ref.date, now)} — same conversational feel.`;
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
  const distKm = distanceEstimate(duration, range);
  const reason = pickEasyReason(ctx, range, distKm);

  const primary: RuleCandidate = {
    type: "easy",
    duration_min: duration,
    distance_km_estimate: distKm,
    ...paceFields(range),
    terrain: "any",
    reason,
    priority: 3,
    source: "easy-default",
    tier_break: tierBreakFor("easy"),
  };

  const longerDuration = Math.min(60, duration + 15);
  const longerRange = paceRange(state.typical_pace_flat, 15, 30);
  const longerDist = distanceEstimate(longerDuration, longerRange);
  const longerVariant: RuleCandidate = {
    type: "easy",
    duration_min: longerDuration,
    distance_km_estimate: longerDist,
    ...paceFields(longerRange),
    terrain: "rolling",
    reason: "Or extend it — same conversational effort, on a rolling route.",
    priority: 6,
    source: "easy-rolling",
    tier_break: tierBreakFor("easy"),
  };

  const shorterDuration = Math.max(20, duration - 10);
  const shorterRange = paceRange(state.typical_pace_flat, 15, 25);
  const shorterDist = distanceEstimate(shorterDuration, shorterRange);
  const shorterVariant: RuleCandidate = {
    type: "easy",
    duration_min: shorterDuration,
    distance_km_estimate: shorterDist,
    ...paceFields(shorterRange),
    terrain: "flat",
    reason: "Or trim it — quick shake-out at the same easy effort.",
    priority: 7,
    source: "easy-short",
    tier_break: tierBreakFor("easy"),
  };

  const stridesRange = paceRange(state.typical_pace_flat, 5, 15);
  const stridesDist = distanceEstimate(duration, stridesRange);
  const stridesVariant: RuleCandidate = {
    type: "easy",
    duration_min: duration,
    distance_km_estimate: stridesDist,
    ...paceFields(stridesRange),
    terrain: "flat",
    reason: "Easy run + 4-6 x 20-30s strides at the end — touch some speed without taxing the legs.",
    priority: 8,
    source: "easy-strides",
    tier_break: tierBreakFor("easy"),
  };

  const trailDuration = Math.min(60, duration + 5);
  const trailBase: number | null =
    state.typical_pace_hilly && state.typical_pace_hilly > 0
      ? state.typical_pace_hilly
      : state.typical_pace_flat !== null
      ? state.typical_pace_flat + 30
      : null;
  const trailRange = paceRange(trailBase, 20, 40);
  const trailDist = distanceEstimate(trailDuration, trailRange);
  const trailVariant: RuleCandidate = {
    type: "easy",
    duration_min: trailDuration,
    distance_km_estimate: trailDist,
    ...paceFields(trailRange),
    terrain: "hilly",
    reason: "Take it to the trails or hills — softer surface, climbs do the work, keep effort honest.",
    priority: 8,
    source: "easy-trail",
    tier_break: tierBreakFor("easy"),
  };

  return [primary, longerVariant, shorterVariant, stridesVariant, trailVariant];
}

function intervalsRepProfile(
  raceDistance: "5k" | "10k"
): { repDistanceM: number; paceLowOffset: number; paceHighOffset: number } {
  if (raceDistance === "5k") {
    return { repDistanceM: 600, paceLowOffset: -30, paceHighOffset: -20 };
  }
  return { repDistanceM: 1000, paceLowOffset: -25, paceHighOffset: -15 };
}

function ruleIntervals(ctx: RuleContext, recoveryFired: boolean): RuleCandidate[] {
  if (recoveryFired) return [];
  const { state, prefs } = ctx;
  if (prefs.goal !== "race") return [];
  if (prefs.race_distance !== "5k" && prefs.race_distance !== "10k") return [];
  if (inRaceWeek(ctx)) return [];
  if (state.days_since_last_quality_session < 2) return [];

  const yesterday = state.last_3_activities[0];
  if (yesterday) {
    const hoursAgo = (ctx.now.getTime() - yesterday.date.getTime()) / 3_600_000;
    if (hoursAgo <= 36 && yesterday.effort_bucket === "hard") return [];
  }

  const profile = intervalsRepProfile(prefs.race_distance);
  const range = paceRange(state.typical_pace_flat, profile.paceLowOffset, profile.paceHighOffset);

  const repPaceSecPerKm =
    range !== null
      ? (range.low + range.high) / 2
      : state.typical_pace_flat !== null && state.typical_pace_flat > 0
      ? state.typical_pace_flat - 25
      : 360;
  const repDurationS = Math.round((profile.repDistanceM / 1000) * repPaceSecPerKm);
  const recoveryDurationS = Math.round(repDurationS * 0.6);

  const weeklyAvg = state.load_28d_weekly_avg > 0 ? state.load_28d_weekly_avg : 120;
  const workTimeCapMin = weeklyAvg * 0.06;
  const repsFromCap = Math.floor((workTimeCapMin * 60) / repDurationS);
  const repetitions = Math.max(3, Math.min(12, repsFromCap || 3));

  const warmupMin = 12;
  const cooldownMin = 10;
  const workMin = (repDurationS * repetitions) / 60;
  const recoveryMin = (recoveryDurationS * repetitions) / 60;
  const totalDurationMin = Math.round(warmupMin + workMin + recoveryMin + cooldownMin);

  const pacePhrase = range
    ? `at ${paceRangeToken(range.low, range.high)}`
    : "at goal-race effort";
  const reason = `${repetitions} × ${profile.repDistanceM}m ${pacePhrase} with jog recovery — sharpen ${prefs.race_distance} speed.`;

  return [
    {
      type: "intervals",
      duration_min: totalDurationMin,
      distance_km_estimate: distanceEstimate(Math.round(workMin), range),
      ...paceFields(range),
      terrain: "flat",
      reason,
      priority: 2,
      source: "quality-intervals",
      tier_break: tierBreakFor("intervals"),
      warmup_min: warmupMin,
      cooldown_min: cooldownMin,
      repetitions,
      rep_distance_m: profile.repDistanceM,
      rep_duration_s: repDurationS,
      recovery_duration_s: recoveryDurationS,
      recovery_type: "jog",
    },
  ];
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
      pace_range: null,
      terrain: "any",
      reason: "You already ran today — yoga, easy bike, or a brisk walk fits the gap.",
      priority: 4,
      source: "cross-already-ran",
      tier_break: tierBreakFor("cross-train"),
    });
  }

  if (prefs.volume_preference === "recover" && state.load_7d_min > 0.8 * state.load_28d_weekly_avg) {
    out.push({
      type: "rest",
      duration_min: 0,
      distance_km_estimate: 0,
      pace_range: null,
      terrain: "any",
      reason: "Recovery week — sit this one out and let adaptations land.",
      priority: 4,
      source: "rest-recover-pref",
      tier_break: tierBreakFor("rest"),
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
      pace_range: null,
      terrain: "any",
      reason: "Easy bike or swim — same aerobic stimulus, zero impact.",
      priority: 9,
      source: "alt-cross-bike",
      tier_break: tierBreakFor("cross-train"),
    },
    {
      type: "cross-train",
      duration_min: 30,
      distance_km_estimate: 0,
      pace_range: null,
      terrain: "any",
      reason: "Strength + mobility — hips, glutes, core. Builds what running can't.",
      priority: 10,
      source: "alt-cross-strength",
      tier_break: tierBreakFor("cross-train"),
    },
    {
      type: "rest",
      duration_min: 0,
      distance_km_estimate: 0,
      pace_range: null,
      terrain: "any",
      reason: "Take it fully off — adaptation happens between sessions.",
      priority: 11,
      source: "alt-rest",
      tier_break: tierBreakFor("rest"),
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

  const tempoCandidates = ruleQualitySession(ctx, recoveryFired);
  const intervalsCandidates = ruleIntervals(ctx, recoveryFired);
  const qualityCandidates = resolveQualityConflict(state, tempoCandidates, intervalsCandidates);

  return [
    ...recovery,
    ...ruleLongRun(ctx, recoveryFired),
    ...qualityCandidates,
    ...ruleEasyDefault(ctx, recoveryFired),
    ...ruleCrossOrRest(ctx, recoveryFired),
    ...ruleAlternativeOptions(),
  ];
}

function resolveQualityConflict(
  state: AthleteState,
  tempoCandidates: RuleCandidate[],
  intervalsCandidates: RuleCandidate[]
): RuleCandidate[] {
  const tempoFired = tempoCandidates.some((c) => c.type === "tempo");
  const intervalsFired = intervalsCandidates.length > 0;
  if (!(tempoFired && intervalsFired)) {
    return [...tempoCandidates, ...intervalsCandidates];
  }
  // Older session-type wins. Ties (including both-never-done) favor intervals,
  // which is otherwise underrepresented in tempo-default rotations.
  if (state.days_since_last_intervals >= state.days_since_last_tempo) {
    return intervalsCandidates;
  }
  return tempoCandidates;
}

export const __testing = {
  recoveryOverrideTriggered,
  inTaperWindow,
  paceRange,
  paceFields,
  distToken,
  paceToken,
  paceRangeToken,
  easyDuration,
  findReferenceRun,
  refDateLabel,
};
