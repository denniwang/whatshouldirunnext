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
import { generateSuggestions } from "@/lib/suggestions/engine";
import { generateCandidates } from "@/lib/suggestions/rules";
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
      expect(s.pace_target_low).toBeGreaterThanOrEqual(240);
      expect(s.pace_target_high).toBeLessThanOrEqual(540);
      expect(s.pace_target_low).toBeLessThanOrEqual(s.pace_target_high);
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
      rawAct({ daysAgo: 2, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 4, moving_time: 35 * 60 }),
      rawAct({ daysAgo: 18, moving_time: 30 * 60 }),
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
      rawAct({ daysAgo: 2, moving_time: 60 * 60, distance: 10000 }),
      rawAct({ daysAgo: 5, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 12, moving_time: 35 * 60 }),
      rawAct({ daysAgo: 18, moving_time: 30 * 60 }),
    ];
    const p = processActivities(acts);
    const { suggestions } = generateSuggestions(p, prefs, monday);
    expect(suggestions.some((s) => s.type === "long")).toBe(true);
  });

  it("returning_from_break mode when no runs in last 14 days", () => {
    const acts = [
      rawAct({ daysAgo: 20, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 25, moving_time: 35 * 60 }),
      rawAct({ daysAgo: 30, moving_time: 30 * 60 }),
    ];
    const p = processActivities(acts);
    const { suggestions, mode } = generateSuggestions(p, BASE_PREFS, NOW);
    expect(mode).toBe("returning");
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]!.duration_min).toBeLessThanOrEqual(30);
  });

  it("onboarding mode when <14 days of history", () => {
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
    expect(candidates.some((c) => c.type === "tempo")).toBe(true);
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
      rawAct({ daysAgo: 2, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 5, moving_time: 35 * 60 }),
      rawAct({ daysAgo: 12, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 18, moving_time: 30 * 60 }),
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
      rawAct({ daysAgo: 20, moving_time: 30 * 60 }),
      rawAct({ daysAgo: 25, moving_time: 35 * 60 }),
      rawAct({ daysAgo: 30, moving_time: 30 * 60 }),
    ];
    const p = processActivities(acts);
    const { alternatives, mode } = generateSuggestions(p, BASE_PREFS, NOW);
    expect(mode).toBe("returning");
    expect(alternatives).toEqual([]);
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
