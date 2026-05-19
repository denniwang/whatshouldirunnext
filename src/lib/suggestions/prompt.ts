import { format } from "date-fns";
import type {
  AthleteState,
  PreferencesInput,
  ProcessedActivity,
  WorkoutSuggestion,
} from "./types";
import {
  DEFAULT_UNITS,
  distanceLabel,
  elevationLabel,
  formatDistance,
  formatElevation,
  formatPace,
  formatReason,
  kmToDisplay,
  type UnitSystem,
} from "@/lib/units";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function goalLabel(p: PreferencesInput): string {
  if (p.goal === "race") {
    const dist = p.race_distance ?? "race";
    const date = p.race_date ? format(p.race_date, "yyyy-MM-dd") : "(no date set)";
    return `Training for a ${dist} on ${date}`;
  }
  return {
    general_fitness: "General fitness",
    weight_loss: "Weight loss",
    returning_from_break: "Returning from a break",
  }[p.goal];
}

function daysAvailableLabel(p: PreferencesInput): string {
  if (p.days_available.length === 0) return "(none chosen)";
  return p.days_available.map((d) => DAY_NAMES[d] ?? `D${d}`).join(", ");
}

function suggLine(s: WorkoutSuggestion, units: UnitSystem): string {
  const pace = s.pace_range
    ? `${formatPace(s.pace_range.low, units)}–${formatPace(s.pace_range.high, units)}`
    : s.pace_note
    ? `tbd (${formatReason(s.pace_note, units)})`
    : "—";
  const dur = s.duration_min > 0 ? `${s.duration_min} min` : "rest";
  const km = s.distance_km_estimate > 0
    ? `~${formatDistance(s.distance_km_estimate, units, 1)}, `
    : "";
  const when = s.for_when === "tomorrow" ? " [for tomorrow]" : "";
  const why = formatReason(s.reason, units);
  return `${s.priority}. ${s.type}${when}: ${dur}, ${km}target ${pace}, ${s.terrain}. Why: ${why}`;
}

export function buildLlmPrompt(
  processed: ProcessedActivity[],
  state: AthleteState,
  prefs: PreferencesInput,
  suggestions: WorkoutSuggestion[],
  now: Date = new Date(),
  units: UnitSystem = DEFAULT_UNITS,
  alternatives: WorkoutSuggestion[] = []
): string {
  const todayName = format(now, "EEEE");
  const todayDate = format(now, "yyyy-MM-dd");
  const distUnit = distanceLabel(units);
  const recent = processed.slice(0, 10).map((a) => {
    const date = format(a.date, "yyyy-MM-dd");
    const dist = formatDistance(a.distance_km, units, 1);
    const elev = formatElevation(a.elevation_gain_m, units);
    return `${date} ${a.type} ${Math.round(a.duration_min)} min, ${dist}, elev ${elev}, GAP ${formatPace(a.grade_adjusted_pace, units)}`;
  });

  const longDay = prefs.long_run_day ? DAY_NAMES[prefs.long_run_day] : "(none)";
  const bothering = prefs.bothering.length === 0 || prefs.bothering.includes("none")
    ? "none"
    : prefs.bothering.join(", ");

  const suggLines = suggestions.map((s) => suggLine(s, units));
  const altLines = alternatives.map((s) => suggLine(s, units));

  const longestRunDist = `${kmToDisplay(state.longest_run_28d_km, units).toFixed(1)} ${distUnit}`;
  const horizon = suggestions.some((s) => s.for_when === "tomorrow") ? "tomorrow" : "today";

  const altSection: (string | null)[] = altLines.length
    ? ["", `Alternatives (extra options for ${horizon}, lower-priority variants):`, ...altLines.map((l) => `- ${l}`)]
    : [];

  return [
    `You are a friendly running coach. I have 3 running-focused suggestions for ${horizon} already — refine into a 7-day running plan and explain reasoning per session.`,
    "",
    "Goal & constraints:",
    `- ${goalLabel(prefs)}`,
    `- Days available this week: ${daysAvailableLabel(prefs)}`,
    `- Long run day: ${longDay}`,
    `- Bothering: ${bothering}`,
    `- Volume preference this week: ${prefs.volume_preference}`,
    `- Preferred units: ${units} (use ${distUnit} for distance, ${elevationLabel(units)} for elevation)`,
    prefs.notes ? `- Notes: ${prefs.notes}` : null,
    "",
    "Training state (running only):",
    `- Running load (last 7 days): ${Math.round(state.load_7d_min)} min`,
    `- Running load (last 28 days): ${Math.round(state.load_28d_min)} min (weekly avg ~${Math.round(state.load_28d_weekly_avg)} min)`,
    `- Suggested weekly target from history: ${state.suggested_weekly_target_min} min`,
    `- Acute:chronic workload ratio: ${state.acwr.toFixed(2)}`,
    `- Days since last run: ${state.days_since_last_run === 999 ? "no runs in window" : state.days_since_last_run}`,
    state.hours_since_last_activity !== null
      ? `- Hours since last activity: ${Math.round(state.hours_since_last_activity)}`
      : null,
    `- Longest run in last 28d: ${Math.round(state.longest_run_28d_min)} min / ${longestRunDist}`,
    state.typical_pace_flat !== null
      ? `- Typical flat pace: ${formatPace(state.typical_pace_flat, units)}`
      : "- Typical flat pace: (not enough data yet)",
    state.typical_pace_hilly && state.typical_pace_hilly !== state.typical_pace_flat
      ? `- Typical hilly GAP: ${formatPace(state.typical_pace_hilly, units)}`
      : null,
    "",
    "Recent activities (most recent first):",
    ...(recent.length ? recent.map((r) => `- ${r}`) : ["- (no activities in last 90 days)"]),
    "",
    `Today is ${todayName} ${todayDate}. My 3 deterministic suggestions (for ${horizon}):`,
    ...suggLines.map((l) => `- ${l}`),
    ...altSection,
    "",
    "Please: (1) tell me which of those three to do and why; (2) outline the remaining 6 days; (3) flag anything risky.",
  ]
    .filter((line): line is string => line !== null && line !== undefined)
    .join("\n");
}

