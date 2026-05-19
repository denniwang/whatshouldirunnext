import { differenceInCalendarDays } from "date-fns";
import type {
  AthleteState,
  PreferencesInput,
  ProcessedActivity,
  RaceDistance,
  WorkoutSuggestion,
  WorkoutType,
} from "./types";
import { computeAthleteState } from "./state";
import {
  generateCandidates,
  compareCandidates,
  tierBreakFor,
  PACE_NOTE_BOOTSTRAP,
  type RuleCandidate,
} from "./rules";

const TARGET_COUNT = 3;
const MAX_ALTERNATIVES = 8;

export interface EngineResult {
  state: AthleteState;
  suggestions: WorkoutSuggestion[];
  alternatives: WorkoutSuggestion[];
  mode: "normal" | "onboarding" | "returning" | "race_day";
}

type TaperBand = { maxDays: number; scalar: number };
const TAPER_BY_DISTANCE: Record<RaceDistance, { windowDays: number; bands: TaperBand[] }> = {
  marathon: { windowDays: 14, bands: [{ maxDays: 7, scalar: 0.6 }, { maxDays: 14, scalar: 0.8 }] },
  ultra: { windowDays: 14, bands: [{ maxDays: 7, scalar: 0.6 }, { maxDays: 14, scalar: 0.8 }] },
  half: { windowDays: 10, bands: [{ maxDays: 5, scalar: 0.65 }, { maxDays: 10, scalar: 0.85 }] },
  "10k": { windowDays: 7, bands: [{ maxDays: 3, scalar: 0.75 }, { maxDays: 7, scalar: 1.0 }] },
  "5k": { windowDays: 5, bands: [{ maxDays: 2, scalar: 0.7 }, { maxDays: 5, scalar: 1.0 }] },
};

export function taperScalar(prefs: PreferencesInput, now: Date): number {
  if (prefs.goal !== "race" || !prefs.race_date || !prefs.race_distance) return 1;
  const days = differenceInCalendarDays(prefs.race_date, now);
  if (days < 0) return 1;
  const cfg = TAPER_BY_DISTANCE[prefs.race_distance];
  if (days > cfg.windowDays) return 1;
  for (const band of cfg.bands) {
    if (days <= band.maxDays) return band.scalar;
  }
  return 1;
}

function isRaceDay(prefs: PreferencesInput, now: Date): boolean {
  if (prefs.goal !== "race" || !prefs.race_date) return false;
  return differenceInCalendarDays(prefs.race_date, now) === 0;
}

function raceDaySuggestion(): WorkoutSuggestion {
  return {
    type: "easy",
    duration_min: 15,
    distance_km_estimate: 2,
    pace_range: null,
    terrain: "flat",
    reason: "Race day — go get it. A 10-15 min shake-out at conversational effort if it helps; otherwise rest until the gun.",
    priority: 1,
  };
}

const TAPER_SCALE_TYPES = new Set<WorkoutType>([
  "easy",
  "long",
  "tempo",
  "intervals",
  "recovery",
]);

function applyTaperScalar(s: WorkoutSuggestion, scalar: number): WorkoutSuggestion {
  if (scalar === 1) return s;
  if (!TAPER_SCALE_TYPES.has(s.type)) return s;
  return { ...s, duration_min: Math.max(1, Math.round(s.duration_min * scalar)) };
}

function stripInternal(c: RuleCandidate): WorkoutSuggestion {
  const { source: _source, tier_break: _tb, ...rest } = c;
  void _source;
  void _tb;
  return rest;
}

function dedupeByType(candidates: RuleCandidate[]): RuleCandidate[] {
  const seen = new Map<string, RuleCandidate>();
  for (const c of [...candidates].sort((a, b) => a.priority - b.priority)) {
    if (!seen.has(c.type)) seen.set(c.type, c);
  }
  return [...seen.values()];
}

function padToThree(candidates: RuleCandidate[], state: AthleteState): RuleCandidate[] {
  const out = [...candidates];
  const have = new Set(out.map((c) => c.type));
  const recoveryMode = have.has("recovery");
  const typical =
    state.typical_pace_flat !== null && state.typical_pace_flat > 0
      ? state.typical_pace_flat
      : null;

  const easyExisting = out.find((c) => c.type === "easy");
  const longExtension: RuleCandidate | null =
    !recoveryMode && easyExisting && !have.has("long")
      ? {
          type: "long",
          duration_min: Math.max(50, easyExisting.duration_min + 20),
          distance_km_estimate:
            typical !== null
              ? +((Math.max(50, easyExisting.duration_min + 20) * 60) / (typical + 25)).toFixed(1)
              : 0,
          ...(typical !== null
            ? {
                pace_range: {
                  low: Math.round(typical + 20),
                  high: Math.round(typical + 35),
                },
              }
            : { pace_range: null, pace_note: PACE_NOTE_BOOTSTRAP }),
          terrain: "rolling",
          reason: "Or extend it — same conversational effort, more time on feet.",
          priority: 9,
          source: "filler-long",
          tier_break: tierBreakFor("long"),
        }
      : null;

  const crossFiller: RuleCandidate = {
    type: "cross-train",
    duration_min: 30,
    distance_km_estimate: 0,
    pace_range: null,
    terrain: "any",
    reason: recoveryMode
      ? "Swap to yoga, easy bike, or mobility work — no impact."
      : "Low-impact cross-training — yoga, easy bike, or mobility work.",
    priority: 10,
    source: "filler-cross",
    tier_break: tierBreakFor("cross-train"),
  };
  const restFiller: RuleCandidate = {
    type: "rest",
    duration_min: 0,
    distance_km_estimate: 0,
    pace_range: null,
    terrain: "any",
    reason: recoveryMode
      ? "Full rest is the right call today."
      : "A planned rest day is part of training — take it.",
    priority: 11,
    source: "filler-rest",
    tier_break: tierBreakFor("rest"),
  };

  const order = recoveryMode
    ? [crossFiller, restFiller]
    : [longExtension, crossFiller, restFiller].filter(Boolean) as RuleCandidate[];

  for (const f of order) {
    if (out.length >= TARGET_COUNT) break;
    if (have.has(f.type)) continue;
    out.push(f);
    have.add(f.type);
  }
  return out;
}

function renumberPriorities(candidates: RuleCandidate[]): RuleCandidate[] {
  return [...candidates]
    .sort(compareCandidates)
    .slice(0, TARGET_COUNT)
    .map((c, i) => ({ ...c, priority: i + 1 }));
}

function stampForWhen(s: WorkoutSuggestion, recentlyTrained: boolean): WorkoutSuggestion {
  return { ...s, for_when: recentlyTrained ? "tomorrow" : "today" };
}

function stampSuggestionId(s: WorkoutSuggestion): WorkoutSuggestion {
  return { ...s, suggestion_id: crypto.randomUUID() };
}

function onboardingSuggestions(prefs: PreferencesInput): WorkoutSuggestion[] {
  const base: WorkoutSuggestion[] = [
    {
      type: "easy",
      duration_min: 25,
      distance_km_estimate: 4,
      pace_range: null,
      pace_note: PACE_NOTE_BOOTSTRAP,
      terrain: "any",
      reason: "Not enough Strava history yet — start conversational and short.",
      priority: 1,
    },
    {
      type: "easy",
      duration_min: 35,
      distance_km_estimate: 5.5,
      pace_range: null,
      pace_note: PACE_NOTE_BOOTSTRAP,
      terrain: "flat",
      reason: "Once the short one feels easy, extend slightly. Same effort.",
      priority: 2,
    },
    {
      type: "rest",
      duration_min: 0,
      distance_km_estimate: 0,
      pace_range: null,
      terrain: "any",
      reason: "Rest or cross-train — recovery matters as much as the run.",
      priority: 3,
    },
  ];
  if (prefs.goal === "race") {
    base[1] = {
      ...base[1]!,
      type: "tempo",
      duration_min: 20,
      reason: "Light tempo to introduce intensity once you've banked a couple of easy runs.",
    };
  }
  return base;
}

function returningSuggestions(): WorkoutSuggestion[] {
  return [
    {
      type: "easy",
      duration_min: 20,
      distance_km_estimate: 3,
      pace_range: { low: 390, high: 450 },
      terrain: "flat",
      reason: "First run back — keep it under 25 min and very easy.",
      priority: 1,
    },
    {
      type: "cross-train",
      duration_min: 30,
      distance_km_estimate: 0,
      pace_range: null,
      terrain: "any",
      reason: "Walk, bike, or mobility — rebuild without impact.",
      priority: 2,
    },
    {
      type: "rest",
      duration_min: 0,
      distance_km_estimate: 0,
      pace_range: null,
      terrain: "any",
      reason: "Rest. Coming back conservatively beats getting hurt again.",
      priority: 3,
    },
  ];
}

const ONBOARDING_MIN_ACTIVITIES = 5;
const ONBOARDING_MIN_LIFETIME_KM = 25;

function isOnboarding(
  processed: ProcessedActivity[],
  prefs: PreferencesInput
): boolean {
  if (prefs.onboarded === false) return true;
  if (processed.length < ONBOARDING_MIN_ACTIVITIES) return true;
  const lifetimeKm = processed.reduce((s, p) => s + p.distance_km, 0);
  if (lifetimeKm < ONBOARDING_MIN_LIFETIME_KM) return true;
  return false;
}

function noRunsInLast14Days(state: AthleteState, now: Date): boolean {
  if (state.total_runs_in_window === 0) return true;
  const last = state.last_3_activities.find((a) => a.type === "Run" || a.type === "TrailRun" || a.type === "VirtualRun");
  if (!last) return true;
  return differenceInCalendarDays(now, last.date) >= 14;
}

export function generateSuggestions(
  processed: ProcessedActivity[],
  prefs: PreferencesInput,
  now: Date = new Date()
): EngineResult {
  const state = computeAthleteState(processed, now);

  if (isOnboarding(processed, prefs)) {
    return {
      state,
      suggestions: onboardingSuggestions(prefs).map(stampSuggestionId),
      alternatives: [],
      mode: "onboarding",
    };
  }
  if (noRunsInLast14Days(state, now)) {
    return {
      state,
      suggestions: returningSuggestions().map(stampSuggestionId),
      alternatives: [],
      mode: "returning",
    };
  }
  if (isRaceDay(prefs, now)) {
    return {
      state,
      suggestions: [raceDaySuggestion()].map(stampSuggestionId),
      alternatives: [],
      mode: "race_day",
    };
  }

  const recentlyTrained =
    state.hours_since_last_activity !== null && state.hours_since_last_activity < 12;

  const raw = generateCandidates(state, prefs, now);
  const deduped = dedupeByType(raw);
  const sorted = [...deduped].sort(compareCandidates);
  const padded = padToThree(sorted, state);
  const finalTop3 = renumberPriorities(padded);
  const top3Sources = new Set(finalTop3.map((c) => c.source));

  const scalar = taperScalar(prefs, now);
  const taperedState: AthleteState =
    scalar === 1
      ? state
      : {
          ...state,
          suggested_weekly_target_min: Math.round(state.suggested_weekly_target_min * scalar),
        };

  const suggestions = finalTop3
    .map(stripInternal)
    .map((s) => applyTaperScalar(s, scalar))
    .map((s) => stampForWhen(s, recentlyTrained))
    .map(stampSuggestionId);

  const alternatives = raw
    .filter((c) => !top3Sources.has(c.source))
    .sort(compareCandidates)
    .slice(0, MAX_ALTERNATIVES)
    .map(stripInternal)
    .map((s) => applyTaperScalar(s, scalar))
    .map((s) => stampForWhen(s, recentlyTrained))
    .map(stampSuggestionId);

  return { state: taperedState, suggestions, alternatives, mode: "normal" };
}
