import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  processActivities,
  processOne,
  isRunLike,
  type RawActivity,
} from "@/lib/suggestions/processed";
import {
  computeAthleteState,
  suggestWeeklyTargetMinutes,
} from "@/lib/suggestions/state";
import { generateSuggestions, taperScalar } from "@/lib/suggestions/engine";
import {
  createInMemoryFeedbackStore,
  getRecentOutcomes,
  recordOutcome,
  setFeedbackStore,
  type SuggestionOutcome,
} from "@/lib/suggestions/feedback";
import {
  generateCandidates,
  compareCandidates,
  TIER_BREAK_BY_TYPE,
  tierBreakFor,
  type RuleCandidate,
} from "@/lib/suggestions/rules";
import type { PreferencesInput } from "@/lib/suggestions/types";

const SAMPLE: RawActivity[] = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../sample.data"), "utf8")
);

const NOW = new Date("2026-05-18T08:00:00Z");

const BASE_PREFS: PreferencesInput = {
  goal: "general_fitness",
  race_distance: null,
  race_date: null,
  days_available: [1, 2, 3, 4, 5, 6],
  long_run_day: 6,
  bothering: [],
  notes: null,
  volume_preference: "maintain",
  onboarded: true,
};

function daysAgo(d: number, hour = 8): Date {
  const t = new Date(NOW);
  t.setUTCDate(t.getUTCDate() - d);
  t.setUTCHours(hour, 0, 0, 0);
  return t;
}

function rawAct(over: Partial<RawActivity> & { daysAgo?: number }): RawActivity {
  const da = over.daysAgo ?? 1;
  const when = daysAgo(da);
  return {
    id: Math.floor(Math.random() * 1e9),
    sport_type: "Run",
    distance: 6000,
    moving_time: 30 * 60,
    total_elevation_gain: 20,
    start_date: when.toISOString(),
    start_date_local: when.toISOString(),
    ...over,
  };
}

describe("processOne", () => {
  it("computes pace and GAP correctly", () => {
    const p = processOne({
      id: 1,
      sport_type: "Run",
      distance: 10000,
      moving_time: 3600,
      total_elevation_gain: 100,
      start_date: "2026-05-01T12:00:00Z",
      start_date_local: "2026-05-01T05:00:00Z",
    });
    expect(p.pace_sec_per_km).toBe(360);
    expect(p.distance_km).toBe(10);
    expect(p.elevation_gain_m).toBe(100);
    expect(p.grade_adjusted_pace).toBeCloseTo(360 - 10 * 0.8, 5);
  });

  it("handles zero distance without dividing by zero", () => {
    const p = processOne({
      id: 1,
      sport_type: "Run",
      distance: 0,
      moving_time: 600,
      start_date: "2026-05-01T12:00:00Z",
      start_date_local: "2026-05-01T05:00:00Z",
    });
    expect(p.pace_sec_per_km).toBe(0);
    expect(p.grade_adjusted_pace).toBe(0);
  });
});

describe("processActivities (effort bucketing)", () => {
  it("buckets the fastest GAP runs as 'hard' and slowest as 'easy'", () => {
    const acts: RawActivity[] = [
      rawAct({ daysAgo: 1, distance: 5000, moving_time: 22 * 60, total_elevation_gain: 0 }),
      rawAct({ daysAgo: 3, distance: 5000, moving_time: 25 * 60, total_elevation_gain: 0 }),
      rawAct({ daysAgo: 5, distance: 5000, moving_time: 28 * 60, total_elevation_gain: 0 }),
      rawAct({ daysAgo: 7, distance: 5000, moving_time: 30 * 60, total_elevation_gain: 0 }),
      rawAct({ daysAgo: 9, distance: 5000, moving_time: 33 * 60, total_elevation_gain: 0 }),
    ];
    const p = processActivities(acts);
    const byPace = [...p].sort((a, b) => a.grade_adjusted_pace - b.grade_adjusted_pace);
    expect(byPace[0]!.effort_bucket).toBe("hard");
    expect(byPace[byPace.length - 1]!.effort_bucket).toBe("easy");
  });

  it("returns 'easy' bucket for non-run activities", () => {
    const acts: RawActivity[] = [
      rawAct({ sport_type: "Run", daysAgo: 1, moving_time: 30 * 60 }),
      rawAct({ sport_type: "Walk", daysAgo: 2, moving_time: 30 * 60, distance: 2000 }),
      rawAct({ sport_type: "Hike", daysAgo: 3, moving_time: 60 * 60, distance: 4000 }),
    ];
    const p = processActivities(acts);
    const walk = p.find((a) => a.type === "Walk")!;
    const hike = p.find((a) => a.type === "Hike")!;
    expect(walk.effort_bucket).toBe("easy");
    expect(walk.effort_score).toBeNull();
    expect(hike.effort_bucket).toBe("easy");
  });
});

describe("computeAthleteState on sample.data", () => {
  const processed = processActivities(SAMPLE);
  const state = computeAthleteState(processed, NOW);

  it("aggregates 7d and 28d loads from real data", () => {
    expect(state.load_7d_min).toBeGreaterThan(0);
    expect(state.load_28d_min).toBeGreaterThanOrEqual(state.load_7d_min);
    expect(state.load_28d_weekly_avg).toBeCloseTo(state.load_28d_min / 4);
  });

  it("computes a sane ACWR", () => {
    expect(state.acwr).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(state.acwr)).toBe(true);
  });

  it("finds last run and longest 28d run", () => {
    expect(state.days_since_last_run).toBeLessThan(5);
    expect(state.longest_run_28d_min).toBeGreaterThan(60);
    expect(state.longest_run_28d_km).toBeGreaterThan(10);
  });

  it("derives a typical_pace_flat from low-elevation runs", () => {
    expect(state.typical_pace_flat).toBeGreaterThan(240);
    expect(state.typical_pace_flat).toBeLessThan(540);
  });

  it("populates last_3_activities most-recent-first", () => {
    expect(state.last_3_activities.length).toBe(3);
    expect(state.last_3_activities[0]!.date.getTime()).toBeGreaterThanOrEqual(
      state.last_3_activities[1]!.date.getTime()
    );
  });

  it("populates recent_runs and hours_since_last_activity", () => {
    expect(state.recent_runs.length).toBeGreaterThan(0);
    expect(state.recent_runs.length).toBeLessThanOrEqual(10);
    expect(state.hours_since_last_activity).not.toBeNull();
    expect(state.hours_since_last_activity!).toBeGreaterThanOrEqual(0);
  });

  it("derives suggested weekly target near the 28d weekly average", () => {
    const stepped = Math.round(state.load_28d_weekly_avg / 15) * 15;
    const expected = Math.max(60, Math.min(900, stepped));
    expect(state.suggested_weekly_target_min).toBe(expected);
  });

  it("only counts runs in load metrics", () => {
    const cutoff7 = NOW.getTime() - 7 * 86_400_000;
    const runMinutes = processed
      .filter((a) => isRunLike(a.type) && a.date.getTime() >= cutoff7)
      .reduce((s, a) => s + a.duration_min, 0);
    expect(state.load_7d_min).toBeCloseTo(runMinutes, 5);
  });
});

describe("suggestWeeklyTargetMinutes", () => {
  it("rounds to a 15-min step and stays within bounds", () => {
    expect(suggestWeeklyTargetMinutes(230)).toBe(225);
    expect(suggestWeeklyTargetMinutes(0)).toBe(120);
    expect(suggestWeeklyTargetMinutes(50)).toBe(60);
    expect(suggestWeeklyTargetMinutes(2000)).toBe(900);
  });

  it("applies volume preference factor", () => {
    expect(suggestWeeklyTargetMinutes(200, "build")).toBe(225);
    expect(suggestWeeklyTargetMinutes(200, "recover")).toBe(165);
    expect(suggestWeeklyTargetMinutes(200, "maintain")).toBe(195);
  });
});

describe("hours_since_last_activity", () => {
  it("computes hours from the most recent activity start", () => {
    const fourHoursAgo = new Date(NOW.getTime() - 4 * 3_600_000);
    const acts = [
      rawAct({
        daysAgo: 0,
        start_date: fourHoursAgo.toISOString(),
        start_date_local: fourHoursAgo.toISOString(),
      }),
    ];
    const p = processActivities(acts);
    const state = computeAthleteState(p, NOW);
    expect(state.hours_since_last_activity).not.toBeNull();
    expect(state.hours_since_last_activity!).toBeCloseTo(4, 1);
  });

  it("is null when there are no activities", () => {
    const state = computeAthleteState([], NOW);
    expect(state.hours_since_last_activity).toBeNull();
  });
});

describe("generateSuggestions — sample.data integration", () => {
  it("returns exactly 3 suggestions on real data", () => {
    const processed = processActivities(SAMPLE);
    const { suggestions, mode } = generateSuggestions(processed, BASE_PREFS, NOW);
    expect(mode).toBe("normal");
    expect(suggestions).toHaveLength(3);
  });

  it("returns an alternatives array on real data", () => {
    const processed = processActivities(SAMPLE);
    const { alternatives } = generateSuggestions(processed, BASE_PREFS, NOW);
    expect(Array.isArray(alternatives)).toBe(true);
    expect(alternatives.length).toBeLessThanOrEqual(8);
  });

  it("includes an easy run by default", () => {
    const processed = processActivities(SAMPLE);
    const { suggestions } = generateSuggestions(processed, BASE_PREFS, NOW);
    expect(suggestions.some((s) => s.type === "easy")).toBe(true);
  });

  it("assigns priorities 1, 2, 3", () => {
    const processed = processActivities(SAMPLE);
    const { suggestions } = generateSuggestions(processed, BASE_PREFS, NOW);
    expect(suggestions.map((s) => s.priority)).toEqual([1, 2, 3]);
  });

  it("paces fall within sane bounds", () => {
    const processed = processActivities(SAMPLE);
    const { suggestions } = generateSuggestions(processed, BASE_PREFS, NOW);
    for (const s of suggestions) {
      if (s.type === "rest" || s.type === "cross-train") continue;
      if (s.duration_min === 0) continue;
      if (!s.pace_range) continue;
      expect(s.pace_range.low).toBeGreaterThanOrEqual(240);
      expect(s.pace_range.high).toBeLessThanOrEqual(540);
      expect(s.pace_range.low).toBeLessThanOrEqual(s.pace_range.high);
    }
  });
});

describe("rules engine — scenario tests", () => {
  it("fires recovery when yesterday was >90 min", () => {
    const acts = [
      rawAct({ daysAgo: 0, moving_time: 100 * 60, distance: 15000 }),
      rawAct({ daysAgo: 4, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 10, moving_time: 40 * 60 }),
      rawAct({ daysAgo: 18, moving_time: 35 * 60 }),
      rawAct({ daysAgo: 25, moving_time: 30 * 60 }),
    ];
    const p = processActivities(acts);
    const { suggestions } = generateSuggestions(p, BASE_PREFS, NOW);
    expect(suggestions[0]!.type).toBe("recovery");
  });

  it("fires recovery + rest when injury chip is set", () => {
    const acts = [
      rawAct({ daysAgo: 2, moving_time: 30 * 60, distance: 6000 }),
      rawAct({ daysAgo: 4, moving_time: 35 * 60, distance: 7000 }),
      rawAct({ daysAgo: 10, moving_time: 35 * 60, distance: 7000 }),
      rawAct({ daysAgo: 14, moving_time: 30 * 60, distance: 6000 }),
      rawAct({ daysAgo: 18, moving_time: 30 * 60, distance: 6000 }),
    ];
    const p = processActivities(acts);
    const prefs: PreferencesInput = { ...BASE_PREFS, bothering: ["knee"] };
    const { suggestions } = generateSuggestions(p, prefs, NOW);
    expect(suggestions[0]!.type).toBe("recovery");
    expect(suggestions.some((s) => s.type === "rest")).toBe(true);
  });

  it("offers a long run when today is the long-run day and no recovery triggered", () => {
    const monday = NOW;
    const prefs: PreferencesInput = { ...BASE_PREFS, long_run_day: 1 };
    const acts = [
      // Last long run was 8 days ago — past the 5-day guard.
      rawAct({ daysAgo: 8, moving_time: 65 * 60, distance: 11000 }),
      rawAct({ daysAgo: 2, moving_time: 30 * 60, distance: 6000 }),
      rawAct({ daysAgo: 5, moving_time: 35 * 60, distance: 7000 }),
      rawAct({ daysAgo: 12, moving_time: 35 * 60, distance: 7000 }),
      rawAct({ daysAgo: 18, moving_time: 30 * 60, distance: 6000 }),
    ];
    const p = processActivities(acts);
    const { suggestions } = generateSuggestions(p, prefs, monday);
    expect(suggestions.some((s) => s.type === "long")).toBe(true);
  });

  it("returning_from_break mode when no runs in last 14 days", () => {
    const acts = [
      rawAct({ daysAgo: 20, moving_time: 30 * 60, distance: 8000 }),
      rawAct({ daysAgo: 25, moving_time: 35 * 60, distance: 9000 }),
      rawAct({ daysAgo: 30, moving_time: 30 * 60, distance: 8000 }),
      rawAct({ daysAgo: 40, moving_time: 35 * 60, distance: 9000 }),
      rawAct({ daysAgo: 55, moving_time: 35 * 60, distance: 9000 }),
    ];
    const p = processActivities(acts);
    const { suggestions, mode } = generateSuggestions(p, BASE_PREFS, NOW);
    expect(mode).toBe("returning");
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]!.duration_min).toBeLessThanOrEqual(30);
  });

  it("onboarding mode when activity count < 5", () => {
    const acts = [
      rawAct({ daysAgo: 1, moving_time: 25 * 60 }),
      rawAct({ daysAgo: 3, moving_time: 30 * 60 }),
    ];
    const p = processActivities(acts);
    const { suggestions, mode } = generateSuggestions(p, BASE_PREFS, NOW);
    expect(mode).toBe("onboarding");
    expect(suggestions).toHaveLength(3);
  });

  it("race goal produces a quality session on a normal day", () => {
    const prefs: PreferencesInput = {
      ...BASE_PREFS,
      goal: "race",
      race_distance: "10k",
      race_date: daysAgo(-60),
      long_run_day: 6,
    };
    const acts = [
      rawAct({ daysAgo: 2, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 5, moving_time: 35 * 60 }),
      rawAct({ daysAgo: 12, moving_time: 40 * 60 }),
      rawAct({ daysAgo: 18, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 25, moving_time: 35 * 60 }),
    ];
    const p = processActivities(acts);
    const candidates = generateCandidates(
      computeAthleteState(p, NOW),
      prefs,
      NOW
    );
    // Either tempo or intervals satisfies "a quality session"; resolveQualityConflict
    // picks one based on days_since_last_<type>.
    expect(candidates.some((c) => c.type === "tempo" || c.type === "intervals")).toBe(true);
  });

  it("isRunLike covers Run, TrailRun, VirtualRun only", () => {
    expect(isRunLike("Run")).toBe(true);
    expect(isRunLike("TrailRun")).toBe(true);
    expect(isRunLike("VirtualRun")).toBe(true);
    expect(isRunLike("Walk")).toBe(false);
    expect(isRunLike("Ride")).toBe(false);
    expect(isRunLike("Hike")).toBe(false);
  });
});

describe("for_when tomorrow when <12hr recency", () => {
  it("stamps for_when='tomorrow' on every top-3 suggestion", () => {
    const fourHoursAgo = new Date(NOW.getTime() - 4 * 3_600_000);
    const acts = [
      rawAct({
        daysAgo: 0,
        moving_time: 30 * 60,
        distance: 6000,
        start_date: fourHoursAgo.toISOString(),
        start_date_local: fourHoursAgo.toISOString(),
      }),
      rawAct({ daysAgo: 5, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 12, moving_time: 35 * 60 }),
      rawAct({ daysAgo: 18, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 25, moving_time: 35 * 60 }),
    ];
    const p = processActivities(acts);
    const { suggestions, alternatives, mode } = generateSuggestions(p, BASE_PREFS, NOW);
    expect(mode).toBe("normal");
    for (const s of suggestions) expect(s.for_when).toBe("tomorrow");
    for (const s of alternatives) expect(s.for_when).toBe("tomorrow");
  });

  it("phrases the easy reason with 'hours ago — tomorrow' wording", () => {
    const fourHoursAgo = new Date(NOW.getTime() - 4 * 3_600_000);
    const acts = [
      rawAct({
        daysAgo: 0,
        moving_time: 30 * 60,
        distance: 6000,
        start_date: fourHoursAgo.toISOString(),
        start_date_local: fourHoursAgo.toISOString(),
      }),
      rawAct({ daysAgo: 5, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 12, moving_time: 35 * 60 }),
      rawAct({ daysAgo: 18, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 25, moving_time: 35 * 60 }),
    ];
    const p = processActivities(acts);
    const { suggestions } = generateSuggestions(p, BASE_PREFS, NOW);
    const easy = suggestions.find((s) => s.type === "easy");
    expect(easy).toBeDefined();
    expect(easy!.reason).toMatch(/hours? ago — tomorrow keep it easy/);
  });

  it("defaults for_when to 'today' when the last activity is older than 12hr", () => {
    const acts = [
      rawAct({ daysAgo: 2, moving_time: 30 * 60, distance: 6000 }),
      rawAct({ daysAgo: 5, moving_time: 35 * 60, distance: 7000 }),
      rawAct({ daysAgo: 9, moving_time: 35 * 60, distance: 7000 }),
      rawAct({ daysAgo: 12, moving_time: 30 * 60, distance: 6000 }),
      rawAct({ daysAgo: 18, moving_time: 30 * 60, distance: 6000 }),
    ];
    const p = processActivities(acts);
    const { suggestions } = generateSuggestions(p, BASE_PREFS, NOW);
    for (const s of suggestions) expect(s.for_when).toBe("today");
  });
});

describe("alternatives surface", () => {
  it("includes same-type easy variants in alternatives", () => {
    const acts = [
      rawAct({ daysAgo: 2, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 5, moving_time: 35 * 60 }),
      rawAct({ daysAgo: 9, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 12, moving_time: 40 * 60 }),
      rawAct({ daysAgo: 18, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 25, moving_time: 35 * 60 }),
    ];
    const p = processActivities(acts);
    const { alternatives, mode } = generateSuggestions(p, BASE_PREFS, NOW);
    expect(mode).toBe("normal");
    expect(alternatives.length).toBeGreaterThan(0);
    expect(alternatives.some((a) => a.type === "easy")).toBe(true);
  });

  it("returns alternatives=[] in onboarding mode", () => {
    const acts = [
      rawAct({ daysAgo: 1, moving_time: 25 * 60 }),
      rawAct({ daysAgo: 3, moving_time: 30 * 60 }),
    ];
    const p = processActivities(acts);
    const { alternatives, mode } = generateSuggestions(p, BASE_PREFS, NOW);
    expect(mode).toBe("onboarding");
    expect(alternatives).toEqual([]);
  });

  it("returns alternatives=[] in returning mode", () => {
    const acts = [
      rawAct({ daysAgo: 20, moving_time: 30 * 60, distance: 8000 }),
      rawAct({ daysAgo: 25, moving_time: 35 * 60, distance: 9000 }),
      rawAct({ daysAgo: 30, moving_time: 30 * 60, distance: 8000 }),
      rawAct({ daysAgo: 40, moving_time: 35 * 60, distance: 9000 }),
      rawAct({ daysAgo: 55, moving_time: 35 * 60, distance: 9000 }),
    ];
    const p = processActivities(acts);
    const { alternatives, mode } = generateSuggestions(p, BASE_PREFS, NOW);
    expect(mode).toBe("returning");
    expect(alternatives).toEqual([]);
  });
});

describe("feedback capture scaffolding", () => {
  it("recordOutcome writes and getRecentOutcomes retrieves matching rows", async () => {
    const store = createInMemoryFeedbackStore();
    setFeedbackStore(store);
    try {
      const now = new Date("2026-05-18T08:00:00Z");
      const o: SuggestionOutcome = {
        suggestion_id: "abc-123",
        user_id: "user-1",
        shown_at: now,
        outcome: "completed",
        actual_activity_id: 9_999_999,
        notes: "felt great",
      };
      await recordOutcome(o);
      const recent = await getRecentOutcomes("user-1", 7);
      expect(recent).toHaveLength(1);
      expect(recent[0]!.suggestion_id).toBe("abc-123");
      expect(recent[0]!.outcome).toBe("completed");

      const other = await getRecentOutcomes("user-2", 7);
      expect(other).toHaveLength(0);
    } finally {
      setFeedbackStore(null);
    }
  });

  it("each generated suggestion has a unique suggestion_id", () => {
    const acts: RawActivity[] = [];
    for (let i = 0; i < 8; i++) {
      acts.push(
        rawAct({
          daysAgo: 2 + i * 3,
          moving_time: 35 * 60,
          distance: 7000,
          total_elevation_gain: 10,
        })
      );
    }
    const p = processActivities(acts);
    const { suggestions, alternatives } = generateSuggestions(p, BASE_PREFS, NOW);
    const ids = [...suggestions, ...alternatives].map((s) => s.suggestion_id);
    for (const id of ids) {
      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("suggestion_ids are stable within a single generateSuggestions call", () => {
    const acts: RawActivity[] = [];
    for (let i = 0; i < 8; i++) {
      acts.push(
        rawAct({
          daysAgo: 2 + i * 3,
          moving_time: 35 * 60,
          distance: 7000,
          total_elevation_gain: 10,
        })
      );
    }
    const p = processActivities(acts);
    const result = generateSuggestions(p, BASE_PREFS, NOW);
    const before = result.suggestions.map((s) => s.suggestion_id);
    const after = result.suggestions.map((s) => s.suggestion_id);
    expect(after).toEqual(before);
  });

  it("onboarding mode also stamps suggestion_ids", () => {
    const { suggestions } = generateSuggestions([], BASE_PREFS, NOW);
    expect(suggestions.every((s) => typeof s.suggestion_id === "string")).toBe(true);
  });
});

describe("global distance-aware taper", () => {
  function racePrefs(distance: "5k" | "10k" | "half" | "marathon" | "ultra", daysOut: number): PreferencesInput {
    return {
      ...BASE_PREFS,
      goal: "race",
      race_distance: distance,
      race_date: daysAgo(-daysOut),
      long_run_day: 6,
    };
  }

  it("taperScalar returns expected values per distance band", () => {
    expect(taperScalar(racePrefs("marathon", 10), NOW)).toBeCloseTo(0.8);
    expect(taperScalar(racePrefs("marathon", 3), NOW)).toBeCloseTo(0.6);
    expect(taperScalar(racePrefs("marathon", 15), NOW)).toBe(1);

    expect(taperScalar(racePrefs("half", 8), NOW)).toBeCloseTo(0.85);
    expect(taperScalar(racePrefs("half", 4), NOW)).toBeCloseTo(0.65);

    expect(taperScalar(racePrefs("10k", 5), NOW)).toBe(1);
    expect(taperScalar(racePrefs("10k", 2), NOW)).toBeCloseTo(0.75);

    expect(taperScalar(racePrefs("5k", 4), NOW)).toBe(1);
    expect(taperScalar(racePrefs("5k", 2), NOW)).toBeCloseTo(0.7);
  });

  it("returns 1 (no scaling) when no race_date is set", () => {
    const prefs: PreferencesInput = { ...BASE_PREFS, goal: "race", race_distance: "5k", race_date: null };
    expect(taperScalar(prefs, NOW)).toBe(1);
    const prefs2: PreferencesInput = { ...BASE_PREFS };
    expect(taperScalar(prefs2, NOW)).toBe(1);
  });

  it("scales duration_min on running suggestions but never pace", () => {
    const acts: RawActivity[] = [];
    for (let i = 0; i < 8; i++) {
      acts.push(
        rawAct({
          daysAgo: 2 + i * 3,
          moving_time: 40 * 60,
          distance: 8000,
          total_elevation_gain: 10,
        })
      );
    }
    const p = processActivities(acts);
    const baseline = generateSuggestions(p, BASE_PREFS, NOW);
    const tapered = generateSuggestions(p, racePrefs("marathon", 10), NOW);

    const baselineEasy = baseline.suggestions.find((s) => s.type === "easy")!;
    const taperedEasy = tapered.suggestions.find((s) => s.type === "easy")!;
    expect(baselineEasy).toBeDefined();
    expect(taperedEasy).toBeDefined();
    expect(taperedEasy.duration_min).toBe(Math.max(1, Math.round(baselineEasy.duration_min * 0.8)));
    // Pace unchanged
    expect(taperedEasy.pace_range).toEqual(baselineEasy.pace_range);
  });

  it("5k racer 10 days out → no scaling (outside 5-day window)", () => {
    const acts: RawActivity[] = [];
    for (let i = 0; i < 8; i++) {
      acts.push(
        rawAct({
          daysAgo: 2 + i * 3,
          moving_time: 35 * 60,
          distance: 7000,
          total_elevation_gain: 10,
        })
      );
    }
    const p = processActivities(acts);
    const baseline = generateSuggestions(p, BASE_PREFS, NOW);
    const tapered = generateSuggestions(p, racePrefs("5k", 10), NOW);
    const bEasy = baseline.suggestions.find((s) => s.type === "easy")!;
    const tEasy = tapered.suggestions.find((s) => s.type === "easy")!;
    expect(tEasy.duration_min).toBe(bEasy.duration_min);
  });

  it("5k racer 2 days out → 0.70 scalar applied", () => {
    const acts: RawActivity[] = [];
    for (let i = 0; i < 8; i++) {
      acts.push(
        rawAct({
          daysAgo: 2 + i * 3,
          moving_time: 35 * 60,
          distance: 7000,
          total_elevation_gain: 10,
        })
      );
    }
    const p = processActivities(acts);
    const baseline = generateSuggestions(p, BASE_PREFS, NOW);
    const tapered = generateSuggestions(p, racePrefs("5k", 2), NOW);
    const bEasy = baseline.suggestions.find((s) => s.type === "easy")!;
    const tEasy = tapered.suggestions.find((s) => s.type === "easy")!;
    expect(tEasy.duration_min).toBe(Math.max(1, Math.round(bEasy.duration_min * 0.7)));
  });

  it("race day → returns race_day mode with shakeout suggestion and skips the rules", () => {
    const acts: RawActivity[] = [];
    for (let i = 0; i < 8; i++) {
      acts.push(
        rawAct({
          daysAgo: 2 + i * 3,
          moving_time: 35 * 60,
          distance: 7000,
          total_elevation_gain: 10,
        })
      );
    }
    const p = processActivities(acts);
    const { suggestions, alternatives, mode } = generateSuggestions(
      p,
      racePrefs("marathon", 0),
      NOW
    );
    expect(mode).toBe("race_day");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.reason).toMatch(/Race day/);
    expect(alternatives).toEqual([]);
  });

  it("scales suggested_weekly_target_min by the same scalar", () => {
    const acts: RawActivity[] = [];
    for (let i = 0; i < 8; i++) {
      acts.push(
        rawAct({
          daysAgo: 2 + i * 3,
          moving_time: 40 * 60,
          distance: 8000,
          total_elevation_gain: 10,
        })
      );
    }
    const p = processActivities(acts);
    const baseline = generateSuggestions(p, BASE_PREFS, NOW);
    const tapered = generateSuggestions(p, racePrefs("marathon", 3), NOW);
    expect(tapered.state.suggested_weekly_target_min).toBe(
      Math.round(baseline.state.suggested_weekly_target_min * 0.6)
    );
  });
});

describe("long run flexibility", () => {
  // NOW is Monday 2026-05-18 (ISO 1). Build dates relative to a passed-in 'now'.
  function daysBeforeOf(now: Date, n: number, hour = 8): Date {
    const t = new Date(now);
    t.setUTCDate(t.getUTCDate() - n);
    t.setUTCHours(hour, 0, 0, 0);
    return t;
  }
  function actOn(now: Date, dAgo: number, over: Partial<RawActivity> = {}): RawActivity {
    const when = daysBeforeOf(now, dAgo);
    return {
      id: Math.floor(Math.random() * 1e9),
      sport_type: "Run",
      distance: 6000,
      moving_time: 30 * 60,
      total_elevation_gain: 20,
      start_date: when.toISOString(),
      start_date_local: when.toISOString(),
      ...over,
    };
  }

  const TUESDAY = new Date("2026-05-19T08:00:00Z"); // ISO 2
  const SATURDAY_BEFORE_MONDAY = new Date("2026-05-16T08:00:00Z"); // ISO 6

  it("fires on preferred day when no long run has been done recently", () => {
    const prefs: PreferencesInput = { ...BASE_PREFS, long_run_day: 1 };
    const acts: RawActivity[] = [
      actOn(NOW, 3),
      actOn(NOW, 7),
      actOn(NOW, 11),
      actOn(NOW, 14),
      actOn(NOW, 20, { moving_time: 35 * 60, distance: 7000 }),
    ];
    const p = processActivities(acts);
    const candidates = generateCandidates(computeAthleteState(p, NOW), prefs, NOW);
    expect(candidates.some((c) => c.type === "long")).toBe(true);
  });

  it("does NOT fire on preferred day when a long run was 3 days ago (5-day guard)", () => {
    const prefs: PreferencesInput = { ...BASE_PREFS, long_run_day: 1 };
    const acts: RawActivity[] = [
      actOn(NOW, 3, { moving_time: 75 * 60, distance: 12000 }),
      actOn(NOW, 7),
      actOn(NOW, 11),
      actOn(NOW, 14),
      actOn(NOW, 18, { moving_time: 35 * 60, distance: 7000 }),
    ];
    const p = processActivities(acts);
    const candidates = generateCandidates(computeAthleteState(p, NOW), prefs, NOW);
    expect(candidates.some((c) => c.type === "long")).toBe(false);
  });

  it("fires catch-up the day after preferred day when none done this week", () => {
    // Tuesday (ISO 2), preferred=Monday (ISO 1). Same ISO week starts on Monday.
    const prefs: PreferencesInput = { ...BASE_PREFS, long_run_day: 1 };
    const acts: RawActivity[] = [
      actOn(TUESDAY, 3),
      actOn(TUESDAY, 7),
      actOn(TUESDAY, 11),
      actOn(TUESDAY, 15),
      actOn(TUESDAY, 22, { moving_time: 35 * 60, distance: 7000 }),
    ];
    const p = processActivities(acts);
    const candidates = generateCandidates(computeAthleteState(p, TUESDAY), prefs, TUESDAY);
    expect(candidates.some((c) => c.type === "long")).toBe(true);
  });

  it("does NOT fire catch-up when a long run already happened this ISO week", () => {
    const prefs: PreferencesInput = { ...BASE_PREFS, long_run_day: 1 };
    const acts: RawActivity[] = [
      // Monday (1 day ago from Tuesday) — within this ISO week
      actOn(TUESDAY, 1, { moving_time: 70 * 60, distance: 11500 }),
      actOn(TUESDAY, 5),
      actOn(TUESDAY, 9),
      actOn(TUESDAY, 14),
      actOn(TUESDAY, 21, { moving_time: 35 * 60, distance: 7000 }),
    ];
    const p = processActivities(acts);
    const candidates = generateCandidates(computeAthleteState(p, TUESDAY), prefs, TUESDAY);
    expect(candidates.some((c) => c.type === "long")).toBe(false);
  });

  it("does NOT fire two days before the preferred day (catch-up needs the day to have passed)", () => {
    // Saturday (ISO 6), preferred=Monday next (ISO 1) — but todayISO=6 > prefs.long_run_day=1 evaluates true.
    // Test the spirit: choose a preferred day that's clearly in the future this week.
    // Today Monday (ISO 1), preferred Wednesday (ISO 3). 1 > 3 is false → no catch-up.
    const prefs: PreferencesInput = { ...BASE_PREFS, long_run_day: 3 };
    const acts: RawActivity[] = [
      actOn(NOW, 3),
      actOn(NOW, 7),
      actOn(NOW, 11),
      actOn(NOW, 14),
      actOn(NOW, 21, { moving_time: 35 * 60, distance: 7000 }),
    ];
    const p = processActivities(acts);
    const candidates = generateCandidates(computeAthleteState(p, NOW), prefs, NOW);
    expect(candidates.some((c) => c.type === "long")).toBe(false);
  });

  it("does NOT fire catch-up when recovery is triggered", () => {
    // Saturday with no long run this week, but injury triggers recovery.
    const prefs: PreferencesInput = {
      ...BASE_PREFS,
      long_run_day: 1,
      bothering: ["knee"],
    };
    const acts: RawActivity[] = [
      actOn(SATURDAY_BEFORE_MONDAY, 3),
      actOn(SATURDAY_BEFORE_MONDAY, 7),
      actOn(SATURDAY_BEFORE_MONDAY, 11),
      actOn(SATURDAY_BEFORE_MONDAY, 15),
      actOn(SATURDAY_BEFORE_MONDAY, 22, { moving_time: 35 * 60, distance: 7000 }),
    ];
    const p = processActivities(acts);
    const candidates = generateCandidates(
      computeAthleteState(p, SATURDAY_BEFORE_MONDAY),
      prefs,
      SATURDAY_BEFORE_MONDAY
    );
    expect(candidates.some((c) => c.type === "long")).toBe(false);
  });
});

describe("intervals rule", () => {
  // Build a fixture with one fast run (hard) plus easy baseline so effort buckets fall right.
  function intervalsBaseActs(hardDaysAgo: number, hardDurationMin: number): RawActivity[] {
    return [
      rawAct({
        daysAgo: hardDaysAgo,
        moving_time: hardDurationMin * 60,
        distance: hardDurationMin === 20 ? 5000 : 7000,
        total_elevation_gain: 5,
      }),
      rawAct({ daysAgo: hardDaysAgo + 3, moving_time: 30 * 60, distance: 5000, total_elevation_gain: 5 }),
      rawAct({ daysAgo: hardDaysAgo + 6, moving_time: 35 * 60, distance: 5500, total_elevation_gain: 5 }),
      rawAct({ daysAgo: hardDaysAgo + 10, moving_time: 30 * 60, distance: 5000, total_elevation_gain: 5 }),
      rawAct({ daysAgo: hardDaysAgo + 14, moving_time: 35 * 60, distance: 5500, total_elevation_gain: 5 }),
      rawAct({ daysAgo: hardDaysAgo + 18, moving_time: 30 * 60, distance: 5000, total_elevation_gain: 5 }),
      rawAct({ daysAgo: hardDaysAgo + 22, moving_time: 35 * 60, distance: 5500, total_elevation_gain: 5 }),
    ];
  }

  const RACE_PREFS_5K: PreferencesInput = {
    ...BASE_PREFS,
    goal: "race",
    race_distance: "5k",
    race_date: daysAgo(-60),
    long_run_day: 6,
  };
  const RACE_PREFS_10K: PreferencesInput = {
    ...BASE_PREFS,
    goal: "race",
    race_distance: "10k",
    race_date: daysAgo(-60),
    long_run_day: 6,
  };

  it("fires for a 5k racer with no recent quality session", () => {
    // No hard runs at all → days_since_last_quality_session = 999, no 36h-hard blocker
    const acts: RawActivity[] = Array.from({ length: 6 }, (_, i) =>
      rawAct({
        daysAgo: 2 + i * 4,
        moving_time: 35 * 60,
        distance: 6000,
        total_elevation_gain: 10,
      })
    );
    const p = processActivities(acts);
    const candidates = generateCandidates(computeAthleteState(p, NOW), RACE_PREFS_5K, NOW);
    const intervals = candidates.find((c) => c.type === "intervals");
    expect(intervals).toBeDefined();
    expect(intervals!.repetitions).toBeGreaterThanOrEqual(3);
    expect(intervals!.rep_distance_m).toBe(600);
    expect(intervals!.recovery_type).toBe("jog");
    expect(intervals!.priority).toBe(2);
  });

  it("does NOT fire when a hard tempo was done in the last 36h (10k racer)", () => {
    // Hard run yesterday (duration 30min ≥ 25 → tempo bucket)
    const acts = intervalsBaseActs(1, 30);
    const p = processActivities(acts);
    const candidates = generateCandidates(computeAthleteState(p, NOW), RACE_PREFS_10K, NOW);
    expect(candidates.some((c) => c.type === "intervals")).toBe(false);
  });

  it("does NOT fire during the 7-day race week", () => {
    const acts: RawActivity[] = Array.from({ length: 6 }, (_, i) =>
      rawAct({
        daysAgo: 2 + i * 4,
        moving_time: 35 * 60,
        distance: 6000,
        total_elevation_gain: 10,
      })
    );
    const prefs: PreferencesInput = {
      ...RACE_PREFS_5K,
      race_date: daysAgo(-5),
    };
    const p = processActivities(acts);
    const candidates = generateCandidates(computeAthleteState(p, NOW), prefs, NOW);
    expect(candidates.some((c) => c.type === "intervals")).toBe(false);
  });

  it("conflict: when tempo was 4d ago and intervals 2d ago, tempo wins", () => {
    // One long hard run 4 days ago (tempo bucket), one short hard run 2 days ago (intervals bucket).
    // Many baseline easy runs so the GAP distribution puts both fast runs in the hard bucket.
    const acts: RawActivity[] = [
      // tempo-like: 30 min hard 4d ago
      rawAct({ daysAgo: 4, moving_time: 30 * 60, distance: 7500, total_elevation_gain: 5 }),
      // intervals-like: 18 min hard 2d ago
      rawAct({ daysAgo: 2, moving_time: 18 * 60, distance: 4500, total_elevation_gain: 5 }),
    ];
    for (let i = 0; i < 8; i++) {
      acts.push(
        rawAct({
          daysAgo: 6 + i * 3,
          moving_time: 35 * 60,
          distance: 5500,
          total_elevation_gain: 10,
        })
      );
    }
    const p = processActivities(acts);
    const state = computeAthleteState(p, NOW);
    expect(state.days_since_last_tempo).toBeGreaterThan(state.days_since_last_intervals);

    // To bypass the 36h-hard gate, push the most recent hard further out. Move intervals to 3d ago.
    const acts2: RawActivity[] = [
      rawAct({ daysAgo: 4, moving_time: 30 * 60, distance: 7500, total_elevation_gain: 5 }),
      rawAct({ daysAgo: 3, moving_time: 18 * 60, distance: 4500, total_elevation_gain: 5 }),
    ];
    for (let i = 0; i < 8; i++) {
      acts2.push(
        rawAct({
          daysAgo: 8 + i * 3,
          moving_time: 35 * 60,
          distance: 5500,
          total_elevation_gain: 10,
        })
      );
    }
    const p2 = processActivities(acts2);
    const state2 = computeAthleteState(p2, NOW);
    // tempo older (4d) than intervals (3d) → tempo wins
    expect(state2.days_since_last_tempo).toBeGreaterThan(state2.days_since_last_intervals);
    const candidates = generateCandidates(state2, RACE_PREFS_5K, NOW);
    const types = candidates.map((c) => c.type);
    expect(types).toContain("tempo");
    expect(types).not.toContain("intervals");
  });

  it("fires with null pace_range + pace_note when typical_pace_flat is null", () => {
    // 5 activities clears onboarding gate, but only 2 are flat-eligible
    const acts: RawActivity[] = [
      rawAct({ daysAgo: 2, moving_time: 30 * 60, distance: 6000, total_elevation_gain: 5 }),
      rawAct({ daysAgo: 5, moving_time: 35 * 60, distance: 6000, total_elevation_gain: 10 }),
      rawAct({ daysAgo: 9, moving_time: 30 * 60, distance: 6000, total_elevation_gain: 200 }),
      rawAct({ daysAgo: 12, moving_time: 35 * 60, distance: 6000, total_elevation_gain: 150 }),
      rawAct({ daysAgo: 18, moving_time: 30 * 60, distance: 6000, total_elevation_gain: 250 }),
    ];
    const p = processActivities(acts);
    const state = computeAthleteState(p, NOW);
    expect(state.typical_pace_flat).toBeNull();
    const candidates = generateCandidates(state, RACE_PREFS_5K, NOW);
    const intervals = candidates.find((c) => c.type === "intervals");
    expect(intervals).toBeDefined();
    expect(intervals!.pace_range).toBeNull();
    expect(intervals!.pace_note).toMatch(/dial in pace targets/);
  });
});

describe("pace fallback strategy", () => {
  it("user with 2 low-elevation runs → typical_pace_flat is null, suggestions get pace_note", () => {
    // 5 activities to clear onboarding gate; only 2 are flat-eligible (elev <30m, dist >=1km)
    const acts = [
      rawAct({ daysAgo: 2, moving_time: 30 * 60, distance: 6000, total_elevation_gain: 5 }),
      rawAct({ daysAgo: 5, moving_time: 35 * 60, distance: 6000, total_elevation_gain: 10 }),
      rawAct({ daysAgo: 9, moving_time: 30 * 60, distance: 6000, total_elevation_gain: 200 }),
      rawAct({ daysAgo: 12, moving_time: 35 * 60, distance: 6000, total_elevation_gain: 150 }),
      rawAct({ daysAgo: 18, moving_time: 30 * 60, distance: 6000, total_elevation_gain: 250 }),
    ];
    const p = processActivities(acts);
    const state = computeAthleteState(p, NOW);
    expect(state.typical_pace_flat).toBeNull();
    const { suggestions } = generateSuggestions(p, BASE_PREFS, NOW);
    const easy = suggestions.find((s) => s.type === "easy");
    expect(easy).toBeDefined();
    expect(easy!.pace_range).toBeNull();
    expect(easy!.pace_note).toBeDefined();
    expect(easy!.pace_note).toMatch(/dial in pace targets/);
  });

  it("user with 10+ low-elevation runs → concrete pace range, no pace_note", () => {
    const acts: RawActivity[] = Array.from({ length: 12 }, (_, i) =>
      rawAct({
        daysAgo: 2 + i * 2,
        moving_time: 30 * 60,
        distance: 6000,
        total_elevation_gain: 10,
      })
    );
    const p = processActivities(acts);
    const state = computeAthleteState(p, NOW);
    expect(state.typical_pace_flat).not.toBeNull();
    expect(state.typical_pace_flat).toBeGreaterThan(0);
    const { suggestions } = generateSuggestions(p, BASE_PREFS, NOW);
    const easy = suggestions.find((s) => s.type === "easy");
    expect(easy).toBeDefined();
    expect(easy!.pace_range).not.toBeNull();
    expect(easy!.pace_note).toBeUndefined();
  });
});

describe("onboarding detection", () => {
  it("brand new user with 0 activities → onboarding", () => {
    const { mode } = generateSuggestions([], BASE_PREFS, NOW);
    expect(mode).toBe("onboarding");
  });

  it("reconnected Strava user with 200 activities all from 2021 → NOT onboarding", () => {
    const acts: RawActivity[] = Array.from({ length: 200 }, (_, i) =>
      rawAct({ daysAgo: 365 * 4 + i, moving_time: 35 * 60, distance: 8000 })
    );
    const p = processActivities(acts);
    const { mode } = generateSuggestions(p, BASE_PREFS, NOW);
    expect(mode).not.toBe("onboarding");
  });

  it("lifelong runner with 10 runs spanning years → NOT onboarding", () => {
    const acts = [
      rawAct({ daysAgo: 5, moving_time: 30 * 60, distance: 6000 }),
      rawAct({ daysAgo: 12, moving_time: 30 * 60, distance: 6000 }),
      rawAct({ daysAgo: 60, moving_time: 30 * 60, distance: 6000 }),
      rawAct({ daysAgo: 120, moving_time: 30 * 60, distance: 6000 }),
      rawAct({ daysAgo: 200, moving_time: 30 * 60, distance: 6000 }),
      rawAct({ daysAgo: 365, moving_time: 30 * 60, distance: 6000 }),
      rawAct({ daysAgo: 500, moving_time: 30 * 60, distance: 6000 }),
      rawAct({ daysAgo: 700, moving_time: 30 * 60, distance: 6000 }),
      rawAct({ daysAgo: 900, moving_time: 30 * 60, distance: 6000 }),
      rawAct({ daysAgo: 1200, moving_time: 30 * 60, distance: 6000 }),
    ];
    const p = processActivities(acts);
    const { mode } = generateSuggestions(p, BASE_PREFS, NOW);
    expect(mode).not.toBe("onboarding");
  });

  it("truly new user with 3 short runs → onboarding", () => {
    const acts = [
      rawAct({ daysAgo: 1, moving_time: 18 * 60, distance: 3000 }),
      rawAct({ daysAgo: 3, moving_time: 20 * 60, distance: 3000 }),
      rawAct({ daysAgo: 5, moving_time: 20 * 60, distance: 3000 }),
    ];
    const p = processActivities(acts);
    const { mode } = generateSuggestions(p, BASE_PREFS, NOW);
    expect(mode).toBe("onboarding");
  });

  it("explicit onboarded=false forces onboarding even with long history", () => {
    const acts: RawActivity[] = Array.from({ length: 50 }, (_, i) =>
      rawAct({ daysAgo: 10 + i, moving_time: 35 * 60, distance: 8000 })
    );
    const p = processActivities(acts);
    const prefs: PreferencesInput = { ...BASE_PREFS, onboarded: false };
    const { mode } = generateSuggestions(p, prefs, NOW);
    expect(mode).toBe("onboarding");
  });
});

describe("dedupe + tier_break tie-breaking", () => {
  function mkCandidate(over: Partial<RuleCandidate>): RuleCandidate {
    const type = over.type ?? "easy";
    return {
      type,
      duration_min: 30,
      distance_km_estimate: 5,
      pace_range: { low: 360, high: 420 },
      terrain: "any",
      reason: "test",
      priority: 5,
      source: "test",
      tier_break: tierBreakFor(type),
      ...over,
    } as RuleCandidate;
  }

  it("dedupeByType keeps the candidate with the lowest priority per type", () => {
    const a = mkCandidate({ type: "easy", priority: 3, source: "a" });
    const b = mkCandidate({ type: "easy", priority: 7, source: "b" });
    const sorted = [b, a].sort(compareCandidates);
    expect(sorted[0]!.source).toBe("a");
    expect(sorted[0]!.priority).toBe(3);
  });

  it("recovery wins the slot when recovery and long_run share priority 1", () => {
    const longCand = mkCandidate({
      type: "long",
      priority: 1,
      source: "long-run",
    });
    const recoveryCand = mkCandidate({
      type: "recovery",
      priority: 1,
      source: "recovery",
    });
    const sorted = [longCand, recoveryCand].sort(compareCandidates);
    expect(sorted[0]!.type).toBe("recovery");
    expect(sorted[1]!.type).toBe("long");
  });

  it("documents the invariant: lower number wins for priority AND tier_break", () => {
    expect(TIER_BREAK_BY_TYPE.recovery).toBeLessThan(TIER_BREAK_BY_TYPE.long);
    expect(TIER_BREAK_BY_TYPE.long).toBeLessThan(TIER_BREAK_BY_TYPE.tempo);
    expect(TIER_BREAK_BY_TYPE.tempo).toBe(TIER_BREAK_BY_TYPE.intervals);
    expect(TIER_BREAK_BY_TYPE.tempo).toBeLessThan(TIER_BREAK_BY_TYPE.easy);
    expect(TIER_BREAK_BY_TYPE.easy).toBeLessThan(TIER_BREAK_BY_TYPE["cross-train"]);
    expect(TIER_BREAK_BY_TYPE["cross-train"]).toBeLessThan(TIER_BREAK_BY_TYPE.rest);

    const lowerPri = mkCandidate({ type: "easy", priority: 2, source: "lo" });
    const higherPri = mkCandidate({ type: "easy", priority: 5, source: "hi" });
    expect(compareCandidates(lowerPri, higherPri)).toBeLessThan(0);

    const easyTie = mkCandidate({ type: "easy", priority: 2, source: "e" });
    const tempoTie = mkCandidate({ type: "tempo", priority: 2, source: "t" });
    expect(compareCandidates(tempoTie, easyTie)).toBeLessThan(0);
  });
});

describe("reference-activity templated reason", () => {
  it("references a comparable past easy run in the easy suggestion's reason", () => {
    const acts = [
      rawAct({ daysAgo: 1, moving_time: 28 * 60, distance: 5000 }),
      rawAct({ daysAgo: 3, moving_time: 28 * 60, distance: 5000 }),
      rawAct({ daysAgo: 5, moving_time: 35 * 60, distance: 5000 }),
      rawAct({ daysAgo: 7, moving_time: 28 * 60, distance: 5000 }),
      rawAct({ daysAgo: 14, moving_time: 28 * 60, distance: 5000 }),
    ];
    const p = processActivities(acts);
    const { suggestions } = generateSuggestions(p, BASE_PREFS, NOW);
    const easy = suggestions.find((s) => s.type === "easy");
    expect(easy).toBeDefined();
    expect(easy!.reason).toMatch(/Match the effort of your/);
  });
});
