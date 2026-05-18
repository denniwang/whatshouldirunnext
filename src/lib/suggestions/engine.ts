import { differenceInCalendarDays } from "date-fns";
import type {
  AthleteState,
  PreferencesInput,
  ProcessedActivity,
  WorkoutSuggestion,
} from "./types";
import { computeAthleteState } from "./state";
import { generateCandidates, type RuleCandidate } from "./rules";

const TARGET_COUNT = 3;
const MAX_ALTERNATIVES = 8;

export interface EngineResult {
  state: AthleteState;
  suggestions: WorkoutSuggestion[];
  alternatives: WorkoutSuggestion[];
  mode: "normal" | "onboarding" | "returning";
}

function stripSource(c: RuleCandidate): WorkoutSuggestion {
  const { source: _source, ...rest } = c;
  void _source;
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
  const typical = state.typical_pace_flat > 0 ? state.typical_pace_flat : 360;

  const easyExisting = out.find((c) => c.type === "easy");
  const longExtension: RuleCandidate | null =
    !recoveryMode && easyExisting && !have.has("long")
      ? {
          type: "long",
          duration_min: Math.max(50, easyExisting.duration_min + 20),
          distance_km_estimate: +((Math.max(50, easyExisting.duration_min + 20) * 60) / (typical + 25)).toFixed(1),
          pace_target_low: Math.round(typical + 20),
          pace_target_high: Math.round(typical + 35),
          terrain: "rolling",
          reason: "Or extend it — same conversational effort, more time on feet.",
          priority: 9,
          source: "filler-long",
        }
      : null;

  const crossFiller: RuleCandidate = {
    type: "cross-train",
    duration_min: 30,
    distance_km_estimate: 0,
    pace_target_low: 0,
    pace_target_high: 0,
    terrain: "any",
    reason: recoveryMode
      ? "Swap to yoga, easy bike, or mobility work — no impact."
      : "Low-impact cross-training — yoga, easy bike, or mobility work.",
    priority: 10,
    source: "filler-cross",
  };
  const restFiller: RuleCandidate = {
    type: "rest",
    duration_min: 0,
    distance_km_estimate: 0,
    pace_target_low: 0,
    pace_target_high: 0,
    terrain: "any",
    reason: recoveryMode
      ? "Full rest is the right call today."
      : "A planned rest day is part of training — take it.",
    priority: 11,
    source: "filler-rest",
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
    .sort((a, b) => a.priority - b.priority)
    .slice(0, TARGET_COUNT)
    .map((c, i) => ({ ...c, priority: i + 1 }));
}

function stampForWhen(s: WorkoutSuggestion, recentlyTrained: boolean): WorkoutSuggestion {
  return { ...s, for_when: recentlyTrained ? "tomorrow" : "today" };
}

function onboardingSuggestions(prefs: PreferencesInput): WorkoutSuggestion[] {
  const base: WorkoutSuggestion[] = [
    {
      type: "easy",
      duration_min: 25,
      distance_km_estimate: 4,
      pace_target_low: 360,
      pace_target_high: 420,
      terrain: "any",
      reason: "Not enough Strava history yet — start conversational and short.",
      priority: 1,
    },
    {
      type: "easy",
      duration_min: 35,
      distance_km_estimate: 5.5,
      pace_target_low: 360,
      pace_target_high: 420,
      terrain: "flat",
      reason: "Once the short one feels easy, extend slightly. Same effort.",
      priority: 2,
    },
    {
      type: "rest",
      duration_min: 0,
      distance_km_estimate: 0,
      pace_target_low: 0,
      pace_target_high: 0,
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
      pace_target_low: 390,
      pace_target_high: 450,
      terrain: "flat",
      reason: "First run back — keep it under 25 min and very easy.",
      priority: 1,
    },
    {
      type: "cross-train",
      duration_min: 30,
      distance_km_estimate: 0,
      pace_target_low: 0,
      pace_target_high: 0,
      terrain: "any",
      reason: "Walk, bike, or mobility — rebuild without impact.",
      priority: 2,
    },
    {
      type: "rest",
      duration_min: 0,
      distance_km_estimate: 0,
      pace_target_low: 0,
      pace_target_high: 0,
      terrain: "any",
      reason: "Rest. Coming back conservatively beats getting hurt again.",
      priority: 3,
    },
  ];
}

function hasEnoughHistory(processed: ProcessedActivity[], now: Date): boolean {
  if (processed.length === 0) return false;
  const oldest = processed.reduce((o, p) => (p.date < o ? p.date : o), processed[0]!.date);
  return differenceInCalendarDays(now, oldest) >= 14;
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

  if (!hasEnoughHistory(processed, now)) {
    return {
      state,
      suggestions: onboardingSuggestions(prefs),
      alternatives: [],
      mode: "onboarding",
    };
  }
  if (noRunsInLast14Days(state, now)) {
    return {
      state,
      suggestions: returningSuggestions(),
      alternatives: [],
      mode: "returning",
    };
  }

  const recentlyTrained =
    state.hours_since_last_activity !== null && state.hours_since_last_activity < 12;

  const raw = generateCandidates(state, prefs, now);
  const deduped = dedupeByType(raw);
  const padded = padToThree(deduped, state);
  const finalTop3 = renumberPriorities(padded);
  const top3Sources = new Set(finalTop3.map((c) => c.source));

  const suggestions = finalTop3
    .map(stripSource)
    .map((s) => stampForWhen(s, recentlyTrained));

  const alternatives = raw
    .filter((c) => !top3Sources.has(c.source))
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_ALTERNATIVES)
    .map(stripSource)
    .map((s) => stampForWhen(s, recentlyTrained));

  return { state, suggestions, alternatives, mode: "normal" };
}
