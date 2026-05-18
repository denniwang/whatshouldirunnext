"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const RUN_SPORTS = ["Run", "TrailRun", "VirtualRun"];

const DAYS = [
  { v: 1, label: "Mon" },
  { v: 2, label: "Tue" },
  { v: 3, label: "Wed" },
  { v: 4, label: "Thu" },
  { v: 5, label: "Fri" },
  { v: 6, label: "Sat" },
  { v: 7, label: "Sun" },
];

export interface PreferencesFormValues {
  weeklyTargetMinutes: number;
  weeklyTargetSessions: number;
  intensityPref: "easy" | "balanced" | "hard";
  restDays: number[];
  longSessionDay: number | null;
  maxHr: number | null;
  notes: string;
}

const DEFAULT_VALUES: PreferencesFormValues = {
  weeklyTargetMinutes: 240,
  weeklyTargetSessions: 4,
  intensityPref: "balanced",
  restDays: [7],
  longSessionDay: 6,
  maxHr: null,
  notes: "",
};

export function PreferencesForm({
  initial,
  method,
  redirectTo = "/dashboard",
  suggestedWeeklyMinutes,
}: {
  initial?: Partial<PreferencesFormValues>;
  method: "POST" | "PATCH";
  redirectTo?: string;
  suggestedWeeklyMinutes?: number | null;
}) {
  const router = useRouter();
  const [values, setValues] = useState<PreferencesFormValues>({
    ...DEFAULT_VALUES,
    ...(suggestedWeeklyMinutes ? { weeklyTargetMinutes: suggestedWeeklyMinutes } : {}),
    ...initial,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleRestDay = (d: number) =>
    setValues((v) => ({
      ...v,
      restDays: v.restDays.includes(d) ? v.restDays.filter((x) => x !== d) : [...v.restDays, d],
    }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/preferences", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...values, sports: RUN_SPORTS }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${res.status}`);
      }
      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  };

  const showSuggestion =
    suggestedWeeklyMinutes != null &&
    suggestedWeeklyMinutes !== values.weeklyTargetMinutes;

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div>
        <label htmlFor="weekly-min" className="label">
          Weekly running target: {values.weeklyTargetMinutes} min
        </label>
        <input
          id="weekly-min"
          type="range"
          min={60}
          max={900}
          step={15}
          value={values.weeklyTargetMinutes}
          onChange={(e) =>
            setValues((v) => ({ ...v, weeklyTargetMinutes: parseInt(e.target.value, 10) }))
          }
          className="w-full accent-strava"
        />
        {suggestedWeeklyMinutes != null && (
          <p className="mt-1 text-xs text-[var(--muted)]">
            Suggested from your last 28 days: {suggestedWeeklyMinutes} min/wk.{" "}
            {showSuggestion && (
              <button
                type="button"
                className="underline text-strava"
                onClick={() =>
                  setValues((v) => ({ ...v, weeklyTargetMinutes: suggestedWeeklyMinutes }))
                }
              >
                Use suggested
              </button>
            )}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="weekly-sessions" className="label">
          Runs per week
        </label>
        <input
          id="weekly-sessions"
          type="number"
          min={1}
          max={14}
          value={values.weeklyTargetSessions}
          onChange={(e) =>
            setValues((v) => ({
              ...v,
              weeklyTargetSessions: parseInt(e.target.value, 10) || 1,
            }))
          }
          className="input"
        />
      </div>

      <div>
        <label className="label">Intensity preference</label>
        <div className="flex gap-2">
          {(["easy", "balanced", "hard"] as const).map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => setValues((v) => ({ ...v, intensityPref: i }))}
              className="chip flex-1"
              data-active={values.intensityPref === i}
            >
              {i}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Rest days</label>
        <div className="flex gap-2 flex-wrap">
          {DAYS.map((d) => (
            <button
              key={d.v}
              type="button"
              onClick={() => toggleRestDay(d.v)}
              className="chip"
              data-active={values.restDays.includes(d.v)}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Long run day (optional)</label>
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setValues((v) => ({ ...v, longSessionDay: null }))}
            className="chip"
            data-active={values.longSessionDay === null}
          >
            none
          </button>
          {DAYS.map((d) => (
            <button
              key={d.v}
              type="button"
              onClick={() => setValues((v) => ({ ...v, longSessionDay: d.v }))}
              className="chip"
              data-active={values.longSessionDay === d.v}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label htmlFor="max-hr" className="label">
          Max heart rate (optional, helps intensity classification)
        </label>
        <input
          id="max-hr"
          type="number"
          min={120}
          max={230}
          placeholder="e.g. 190"
          value={values.maxHr ?? ""}
          onChange={(e) =>
            setValues((v) => ({
              ...v,
              maxHr: e.target.value ? parseInt(e.target.value, 10) : null,
            }))
          }
          className="input"
        />
      </div>

      <div>
        <label htmlFor="notes" className="label">
          Notes (optional, included in LLM prompt)
        </label>
        <textarea
          id="notes"
          value={values.notes}
          onChange={(e) => setValues((v) => ({ ...v, notes: e.target.value }))}
          rows={3}
          className="input"
          placeholder="Training for a 10K, knee a bit sore lately, etc."
        />
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <button type="submit" disabled={submitting} className="btn-primary w-full">
        {submitting ? "Saving..." : "Save"}
      </button>
    </form>
  );
}
