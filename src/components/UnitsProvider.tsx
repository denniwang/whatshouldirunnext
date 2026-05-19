"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
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

interface UnitsContextValue {
  units: UnitSystem;
  setUnits: (next: UnitSystem) => void;
}

const UnitsContext = createContext<UnitsContextValue | null>(null);

export function UnitsProvider({
  initial,
  children,
}: {
  initial: UnitSystem;
  children: ReactNode;
}) {
  const [units, setUnitsState] = useState<UnitSystem>(initial);

  // Reconcile against localStorage on mount: if a previous session set a
  // preference but the cookie was cleared (e.g. private window), restore it.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(UNITS_STORAGE_KEY);
      if (isUnitSystem(stored) && stored !== units) {
        setUnitsState(stored);
        writeCookie(stored);
      } else if (!stored) {
        window.localStorage.setItem(UNITS_STORAGE_KEY, units);
      }
    } catch {
      // localStorage may be unavailable; ignore.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setUnits = useCallback((next: UnitSystem) => {
    setUnitsState(next);
    try {
      window.localStorage.setItem(UNITS_STORAGE_KEY, next);
    } catch {
      // ignore
    }
    writeCookie(next);
  }, []);

  return (
    <UnitsContext.Provider value={{ units, setUnits }}>
      {children}
    </UnitsContext.Provider>
  );
}

export function useUnits(): UnitSystem {
  const ctx = useContext(UnitsContext);
  return ctx?.units ?? DEFAULT_UNITS;
}

export function useUnitsContext(): UnitsContextValue {
  const ctx = useContext(UnitsContext);
  if (!ctx) {
    // Outside a provider: degrade to a no-op setter using the default.
    return { units: DEFAULT_UNITS, setUnits: () => {} };
  }
  return ctx;
}
