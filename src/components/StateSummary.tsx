"use client";
import {
  renderStateSummary,
  type StateSummaryParts,
} from "@/lib/suggestions/state-summary";
import { useUnits } from "./UnitsProvider";

export function StateSummary({ parts }: { parts: StateSummaryParts }) {
  const units = useUnits();
  const text = renderStateSummary(parts, units);
  if (!text) return null;
  return <p className="mt-0.5 text-xs text-[var(--muted)]">{text}</p>;
}
