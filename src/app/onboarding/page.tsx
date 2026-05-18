import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { preferences } from "@/db/schema";
import { eq } from "drizzle-orm";
import { PreferencesForm } from "@/components/PreferencesForm";
import { getCachedActivities } from "@/lib/strava/sync";
import { processActivities, type RawActivity } from "@/lib/suggestions/processed";
import { computeAthleteState } from "@/lib/suggestions/state";

export default async function OnboardingPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const userId = session.user.id;
  const existing = await db
    .select()
    .from(preferences)
    .where(eq(preferences.userId, userId))
    .limit(1);
  if (existing.length > 0) redirect("/dashboard");

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
  const state = computeAthleteState(processed, new Date());
  const suggested =
    state.total_runs_in_window >= 3 ? state.suggested_weekly_target_min : null;

  return (
    <main className="mx-auto max-w-md px-5 py-8">
      <h1 className="text-2xl font-bold mb-2">Set your preferences</h1>
      <p className="text-sm text-[var(--muted)] mb-6">
        You can edit these later from the dashboard.
      </p>
      <PreferencesForm
        method="POST"
        redirectTo="/dashboard"
        suggestedWeeklyMinutes={suggested}
      />
    </main>
  );
}
