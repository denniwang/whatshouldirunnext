import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { deauthorize } from "@/lib/strava/client";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return new NextResponse("unauthorized", { status: 401 });
  const userId = session.user.id;
  await deauthorize(userId);
  // Cascade deletes via FK clean up account, preferences, activity_cache,
  // strava_rate_state, and sessions.
  await db.delete(users).where(eq(users.id, userId));
  return NextResponse.json({ ok: true });
}
