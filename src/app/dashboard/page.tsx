import Link from "next/link";
import { format } from "date-fns";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db/client";
import { preferences } from "@/db/schema";
import { syncIfStale, getCachedActivities } from "@/lib/strava/sync";
import { processActivities, isRunLike, type RawActivity } from "@/lib/suggestions/processed";
import { generateSuggestions } from "@/lib/suggestions/engine";
import { buildLlmPrompt } from "@/lib/suggestions/prompt";
import { buildStateSummary } from "@/lib/suggestions/state-summary";
import { adaptDbPrefs } from "@/lib/suggestions/prefs-adapter";
import { SuggestionCard } from "@/components/SuggestionCard";
import { AiPlanModal } from "@/components/AiPlanModal";
import { RefreshButton } from "@/components/RefreshButton";
import { PoweredByStrava } from "@/components/PoweredByStrava";
import { UnitsToggle } from "@/components/UnitsToggle";
import {
  WeekRunsDropdown,
  type WeekRun,
  type WeekStats,
} from "@/components/WeekRunsDropdown";
import { RateLimitedError, ScopeError } from "@/lib/strava/client";
import { DEFAULT_UNITS, UNITS_COOKIE, isUnitSystem } from "@/lib/units";

export const dynamic = "force-dynamic";

const MODE_BANNER: Record<string, { title: string; body: string }> = {
  onboarding: {
    title: "Not enough Strava history yet",
    body: "Hang in there for ~2 weeks of activity — suggestions will get sharper.",
  },
  returning: {
    title: "Welcome back",
    body: "No runs in your last 14 days — easing you in conservatively.",
  },
};

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const userId = session.user.id;

  const cookieStore = await cookies();
  const cookieUnits = cookieStore.get(UNITS_COOKIE)?.value;
  const units = isUnitSystem(cookieUnits) ? cookieUnits : DEFAULT_UNITS;

  const prefRows = await db
    .select()
    .from(preferences)
    .where(eq(preferences.userId, userId))
    .limit(1);
  if (prefRows.length === 0) redirect("/onboarding");
  const prefsInput = adaptDbPrefs(prefRows[0]!);

  let syncError: string | null = null;
  try {
    await syncIfStale(userId);
  } catch (e) {
    if (e instanceof RateLimitedError) {
      syncError = `Strava rate limit. Try again in ${Math.ceil(e.retryAfterSeconds / 60)} min.`;
    } else if (e instanceof ScopeError) {
      syncError = "Missing activity:read_all scope. Reconnect Strava.";
    } else {
      syncError = e instanceof Error ? e.message : "Sync failed";
    }
  }

  const rows = await getCachedActivities(userId, 90);
  const raws: RawActivity[] = rows.map((r) => ({
    id: r.stravaActivityId,
    sport_type: r.sportType,
    distance: r.distanceM,
    moving_time: r.movingTimeS,
    total_elevation_gain: r.totalElevationGainM ?? 0,
    start_date: r.startDate,
    start_date_local: r.startDateLocal,
  }));
  const processed = processActivities(raws);

  const now = new Date();
  const { suggestions, alternatives, state, mode } = generateSuggestions(
    processed,
    prefsInput,
    now
  );
  const weeklyTargetMin = prefRows[0]!.weeklyTargetMinutes;
  const summary = buildStateSummary(
    processed,
    state,
    prefsInput,
    now,
    units,
    weeklyTargetMin
  );
  const prompt = buildLlmPrompt(
    processed,
    state,
    prefsInput,
    suggestions,
    now,
    units,
    alternatives
  );

  const weekCutoff = now.getTime() - 7 * 86_400_000;
  const weekRunsRaw = processed.filter(
    (a) => isRunLike(a.type) && a.date.getTime() >= weekCutoff
  );
  const nameById = new Map<number, string | null>(
    rows.map((r) => [r.stravaActivityId, r.name])
  );
  const weekRuns: WeekRun[] = weekRunsRaw.map((a) => ({
    id: a.id,
    name: nameById.get(a.id) ?? null,
    date: a.date.toISOString(),
    type: a.type,
    duration_min: a.duration_min,
    distance_km: a.distance_km,
    elevation_gain_m: a.elevation_gain_m,
    pace_sec_per_km: a.pace_sec_per_km,
    effort_bucket: a.effort_bucket,
  }));
  const totalDistance = weekRunsRaw.reduce((s, a) => s + a.distance_km, 0);
  const totalDuration = weekRunsRaw.reduce((s, a) => s + a.duration_min, 0);
  const totalElevation = weekRunsRaw.reduce(
    (s, a) => s + a.elevation_gain_m,
    0
  );
  const weekStats: WeekStats = {
    runs: weekRunsRaw.length,
    distance_km: totalDistance,
    duration_min: totalDuration,
    elevation_gain_m: totalElevation,
    avg_pace_sec_per_km:
      totalDistance > 0 ? (totalDuration * 60) / totalDistance : 0,
  };

  return (
    <main className="mx-auto max-w-md px-5 py-6 pb-32">
      <header className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {format(now, "EEEE, MMM d")}
          </h1>
          {summary && (
            <p className="mt-0.5 text-xs text-[var(--muted)]">{summary}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <UnitsToggle initial={units} />
          <Link href="/preferences" className="text-sm text-strava underline">
            Preferences
          </Link>
        </div>
      </header>

      {syncError && (
        <div className="card mb-4 border-amber-500/40 bg-amber-500/10">
          <p className="text-sm text-amber-400">{syncError}</p>
        </div>
      )}

      {mode !== "normal" && MODE_BANNER[mode] && (
        <div className="card mb-4 border-sky-500/40 bg-sky-500/10">
          <p className="text-sm font-medium text-sky-300">{MODE_BANNER[mode]!.title}</p>
          <p className="mt-1 text-xs text-sky-300/80">{MODE_BANNER[mode]!.body}</p>
        </div>
      )}

      <WeekRunsDropdown runs={weekRuns} stats={weekStats} units={units} />

      <section className="space-y-3">
        {suggestions.map((s) => (
          <SuggestionCard key={`${s.priority}-${s.type}`} s={s} units={units} />
        ))}
      </section>

      {alternatives.length > 0 && (
        <details className="mt-4 group">
          <summary className="cursor-pointer list-none rounded-lg border border-[var(--border)] bg-[var(--card)]/60 px-4 py-2 text-sm font-medium text-[var(--muted)] hover:text-[var(--fg)] flex items-center justify-between">
            <span>Show other options ({alternatives.length})</span>
            <span className="text-xs transition-transform group-open:rotate-180">▾</span>
          </summary>
          <div className="mt-3 space-y-3">
            {alternatives.map((s, i) => (
              <SuggestionCard
                key={`alt-${i}-${s.type}-${s.duration_min}`}
                s={s}
                units={units}
                compact
              />
            ))}
          </div>
        </details>
      )}

      <div className="fixed inset-x-0 bottom-0 border-t border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur px-5 py-3">
        <div className="mx-auto flex max-w-md gap-2">
          <AiPlanModal prompt={prompt} />
          <RefreshButton />
        </div>
      </div>

      <PoweredByStrava />
    </main>
  );
}
