"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_UNITS,
  UNITS_COOKIE,
  UNITS_STORAGE_KEY,
  isUnitSystem,
  type UnitSystem,
} from "@/lib/units";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function writeCookie(value: UnitSystem) {
  document.cookie = `${UNITS_COOKIE}=${value}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}

export function UnitsToggle({ initial }: { initial: UnitSystem }) {
  const router = useRouter();
  const [units, setUnits] = useState<UnitSystem>(initial);

  // Reconcile against localStorage on mount; if the user picked something
  // here previously but the cookie was cleared, restore it.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(UNITS_STORAGE_KEY);
      if (isUnitSystem(stored) && stored !== units) {
        setUnits(stored);
        writeCookie(stored);
        router.refresh();
      } else if (!stored) {
        window.localStorage.setItem(UNITS_STORAGE_KEY, units);
      }
    } catch {
      // localStorage may be unavailable; ignore.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (next: UnitSystem) => {
    if (next === units) return;
    setUnits(next);
    try {
      window.localStorage.setItem(UNITS_STORAGE_KEY, next);
    } catch {
      // ignore
    }
    writeCookie(next);
    router.refresh();
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

export { DEFAULT_UNITS };
