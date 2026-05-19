import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db/client";
import { preferences } from "@/db/schema";
import { getCachedActivities, rowToRaw, syncIfStale } from "@/lib/strava/sync";
import { generateSuggestions } from "@/lib/suggestions/engine";
import { buildLlmPrompt } from "@/lib/suggestions/prompt";
import { processActivities } from "@/lib/suggestions/processed";
import { adaptDbPrefs } from "@/lib/suggestions/prefs-adapter";
import { DEFAULT_UNITS, UNITS_COOKIE, isUnitSystem } from "@/lib/units";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return new NextResponse("unauthorized", { status: 401 });
  const userId = session.user.id;
  const cookieStore = await cookies();
  const cookieUnits = cookieStore.get(UNITS_COOKIE)?.value;
  const units = isUnitSystem(cookieUnits) ? cookieUnits : DEFAULT_UNITS;
  const prefRows = await db
    .select()
    .from(preferences)
    .where(eq(preferences.userId, userId))
    .limit(1);
  if (prefRows.length === 0) return NextResponse.json({ error: "no_preferences" }, { status: 400 });
  const prefsInput = adaptDbPrefs(prefRows[0]!);
  try {
    await syncIfStale(userId);
  } catch {
    // serve cached anyway
  }
  const rows = await getCachedActivities(userId, 90);
  const processed = processActivities(rows.map(rowToRaw));
  const now = new Date();
  const result = generateSuggestions(processed, prefsInput, now);
  return NextResponse.json({
    suggestions: result.suggestions,
    alternatives: result.alternatives,
    state: result.state,
    mode: result.mode,
    prompt: buildLlmPrompt(
      processed,
      result.state,
      prefsInput,
      result.suggestions,
      now,
      units,
      result.alternatives
    ),
    activityCount: processed.length,
    units,
  });
}
