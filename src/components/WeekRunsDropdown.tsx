"use client";
import { useState } from "react";
import { format } from "date-fns";
import {
  DEFAULT_UNITS,
  formatDistance,
  formatElevation,
  formatPace,
  type UnitSystem,
} from "@/lib/units";

export interface WeekRun {
  id: number;
  name: string | null;
  date: string;
  type: string;
  duration_min: number;
  distance_km: number;
  elevation_gain_m: number;
  pace_sec_per_km: number;
  effort_bucket: "easy" | "moderate" | "hard";
}

export interface WeekStats {
  runs: number;
  distance_km: number;
  duration_min: number;
  elevation_gain_m: number;
  avg_pace_sec_per_km: number;
}

function formatDuration(min: number): string {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

const EFFORT_COLOR: Record<WeekRun["effort_bucket"], string> = {
  easy: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  moderate: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  hard: "bg-red-500/15 text-red-300 border-red-500/40",
};

export function WeekRunsDropdown({
  runs,
  stats,
  units = DEFAULT_UNITS,
}: {
  runs: WeekRun[];
  stats: WeekStats;
  units?: UnitSystem;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="mb-4 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div>
          <p className="text-sm font-semibold">This week</p>
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            {stats.runs} run{stats.runs === 1 ? "" : "s"}
            {stats.runs > 0 && (
              <>
                {" · "}
                {formatDistance(stats.distance_km, units, 1)}
                {" · "}
                {formatDuration(stats.duration_min)}
                {stats.elevation_gain_m > 0 && (
                  <>
                    {" · "}
                    {formatElevation(stats.elevation_gain_m, units)}
                  </>
                )}
              </>
            )}
          </p>
        </div>
        <svg
          className={`h-4 w-4 shrink-0 text-[var(--muted)] transition-transform ${
            open ? "rotate-180" : ""
          }`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <div className="border-t border-[var(--border)]">
          {runs.length === 0 ? (
            <p className="px-4 py-4 text-xs text-[var(--muted)]">
              No runs in the last 7 days.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {runs.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {r.name || format(new Date(r.date), "EEE, MMM d")}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--muted)]">
                        {format(new Date(r.date), "EEE, MMM d")}
                        {r.type !== "Run" && (
                          <span className="ml-1.5 uppercase tracking-wide">
                            · {r.type}
                          </span>
                        )}
                        {" · "}
                        {formatDistance(r.distance_km, units, 2)}
                        {" · "}
                        {formatDuration(r.duration_min)}
                        {r.pace_sec_per_km > 0 && (
                          <>
                            {" · "}
                            {formatPace(r.pace_sec_per_km, units)}
                          </>
                        )}
                        {r.elevation_gain_m > 0 && (
                          <>
                            {" · "}
                            {formatElevation(r.elevation_gain_m, units)}
                          </>
                        )}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${EFFORT_COLOR[r.effort_bucket]}`}
                    >
                      {r.effort_bucket}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {stats.runs > 0 && stats.avg_pace_sec_per_km > 0 && (
            <div className="border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--muted)]">
              avg pace {formatPace(stats.avg_pace_sec_per_km, units)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
