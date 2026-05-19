import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db/client";
import { preferences } from "@/db/schema";
import { PreferencesForm } from "@/components/PreferencesForm";
import { DisconnectButton } from "@/components/DisconnectButton";
import { PoweredByStrava } from "@/components/PoweredByStrava";
import { getCachedActivities, rowToRaw } from "@/lib/strava/sync";
import { processActivities } from "@/lib/suggestions/processed";
import { computeAthleteState } from "@/lib/suggestions/state";

export const dynamic = "force-dynamic";

export default async function PreferencesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const userId = session.user.id;
  const rows = await db
    .select()
    .from(preferences)
    .where(eq(preferences.userId, userId))
    .limit(1);
  if (rows.length === 0) redirect("/onboarding");
  const p = rows[0]!;

  const acts = await getCachedActivities(userId, 90);
  const processed = processActivities(acts.map(rowToRaw));
  const state = computeAthleteState(processed, new Date());
  const suggested =
    state.total_runs_in_window >= 3 ? state.suggested_weekly_target_min : null;

  return (
    <main className="mx-auto max-w-md px-5 py-6">
      <header className="mb-5 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Preferences</h1>
        <Link href="/dashboard" className="text-sm text-strava underline">
          Back
        </Link>
      </header>
      <PreferencesForm
        method="PATCH"
        redirectTo="/dashboard"
        suggestedWeeklyMinutes={suggested}
        initial={{
          weeklyTargetMinutes: p.weeklyTargetMinutes,
          weeklyTargetSessions: p.weeklyTargetSessions,
          intensityPref: p.intensityPref as "easy" | "balanced" | "hard",
          restDays: p.restDays,
          longSessionDay: p.longSessionDay,
          maxHr: p.maxHr,
          notes: p.notes ?? "",
        }}
      />
      <div className="mt-10 border-t border-[var(--border)] pt-6">
        <DisconnectButton />
      </div>
      <PoweredByStrava />
    </main>
  );
}
