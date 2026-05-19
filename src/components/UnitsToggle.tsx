"use client";
import { useUnitsContext } from "./UnitsProvider";
import type { UnitSystem } from "@/lib/units";

export function UnitsToggle() {
  const { units, setUnits } = useUnitsContext();

  const choose = (next: UnitSystem) => {
    if (next === units) return;
    setUnits(next);
  };

  return (
    <div
      role="group"
      aria-label="Units"
      className="inline-flex overflow-hidden rounded-full border border-[var(--border)] text-[11px]"
    >
      <button
        type="button"
        onClick={() => choose("metric")}
        aria-pressed={units === "metric"}
        className="px-2.5 py-1 transition data-[active=true]:bg-strava data-[active=true]:text-white"
        data-active={units === "metric"}
      >
        km
      </button>
      <button
        type="button"
        onClick={() => choose("imperial")}
        aria-pressed={units === "imperial"}
        className="px-2.5 py-1 transition data-[active=true]:bg-strava data-[active=true]:text-white"
        data-active={units === "imperial"}
      >
        mi
      </button>
    </div>
  );
}
