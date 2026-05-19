"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AthleteState,
  PreferencesInput,
  ProcessedActivity,
  WorkoutSuggestion,
} from "@/lib/suggestions/types";
import { buildLlmPrompt } from "@/lib/suggestions/prompt";
import { useUnits } from "./UnitsProvider";

interface AiPlanModalProps {
  processed: ProcessedActivity[];
  state: AthleteState;
  prefs: PreferencesInput;
  suggestions: WorkoutSuggestion[];
  alternatives: WorkoutSuggestion[];
  nowIso: string;
}

export function AiPlanModal({
  processed,
  state,
  prefs,
  suggestions,
  alternatives,
  nowIso,
}: AiPlanModalProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const units = useUnits();

  const prompt = useMemo(
    () =>
      buildLlmPrompt(
        processed,
        state,
        prefs,
        suggestions,
        new Date(nowIso),
        units,
        alternatives
      ),
    [processed, state, prefs, suggestions, alternatives, nowIso, units]
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="btn-primary flex-1"
        type="button"
      >
        Get an AI plan from these prefs
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md max-h-[85vh] overflow-hidden rounded-t-2xl border border-[var(--border)] bg-[var(--card)] shadow-xl sm:rounded-2xl"
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
              <h2 className="text-sm font-semibold">Copy prompt to AI</h2>
              <button
                className="text-xs text-[var(--muted)] hover:text-[var(--fg)]"
                onClick={() => setOpen(false)}
                aria-label="Close"
                type="button"
              >
                Close
              </button>
            </div>
            <div className="overflow-y-auto px-4 py-3">
              <p className="mb-2 text-xs text-[var(--muted)]">
                Paste this into ChatGPT, Claude, or any LLM for a tailored 7-day plan.
              </p>
              <pre className="whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-black/30 p-3 text-[11px] leading-snug text-[var(--fg)]">
                {prompt}
              </pre>
            </div>
            <div className="border-t border-[var(--border)] px-4 py-3">
              <button
                onClick={onCopy}
                className="btn-primary w-full"
                type="button"
              >
                {copied ? "Copied!" : "Copy to clipboard"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
