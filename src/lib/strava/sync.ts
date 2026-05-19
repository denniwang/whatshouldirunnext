import { eq, desc } from "drizzle-orm";
import { db } from "@/db/client";
import { activityCache, stravaRateState, type ActivityCacheRow } from "@/db/schema";
import { fetchAthleteActivities } from "./client";
import type { RawActivity } from "@/lib/suggestions/processed";

const SYNC_WINDOW_MS = 15 * 60 * 1000;
const LOOKBACK_DAYS = 90;

export async function syncIfStale(userId: string) {
  const rows = await db
    .select()
    .from(stravaRateState)
    .where(eq(stravaRateState.userId, userId))
    .limit(1);
  const state = rows[0];
  const now = Date.now();
  if (
    state?.lastFullSyncAt &&
    now - state.lastFullSyncAt.getTime() < SYNC_WINDOW_MS
  ) {
    return { skipped: true, count: 0 };
  }

  const afterUnix = Math.floor((now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000) / 1000);
  const activities = await fetchAthleteActivities(userId, afterUnix);

  for (const a of activities) {
    await db
      .insert(activityCache)
      .values({
        stravaActivityId: a.id,
        userId,
        sportType: a.sport_type,
        distanceM: a.distance,
        movingTimeS: a.moving_time,
        elapsedTimeS: a.elapsed_time,
        totalElevationGainM: a.total_elevation_gain ?? null,
        averageHeartrate: a.average_heartrate ?? null,
        averageWatts: a.average_watts ?? null,
        startDate: new Date(a.start_date),
        startDateLocal: new Date(a.start_date_local),
        timezone: a.timezone ?? null,
        trainer: a.trainer ?? false,
        commute: a.commute ?? false,
        private: a.private ?? false,
        name: a.name ?? null,
        fetchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: activityCache.stravaActivityId,
        set: {
          sportType: a.sport_type,
          distanceM: a.distance,
          movingTimeS: a.moving_time,
          elapsedTimeS: a.elapsed_time,
          totalElevationGainM: a.total_elevation_gain ?? null,
          averageHeartrate: a.average_heartrate ?? null,
          averageWatts: a.average_watts ?? null,
          name: a.name ?? null,
          fetchedAt: new Date(),
        },
      });
  }

  await db
    .insert(stravaRateState)
    .values({ userId, lastFullSyncAt: new Date() })
    .onConflictDoUpdate({
      target: stravaRateState.userId,
      set: { lastFullSyncAt: new Date() },
    });

  return { skipped: false, count: activities.length };
}

export async function getCachedActivities(userId: string, sinceDays = 90) {
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(activityCache)
    .where(eq(activityCache.userId, userId))
    .orderBy(desc(activityCache.startDate));
  return rows.filter((r) => r.startDate >= cutoff);
}

export function rowToRaw(r: ActivityCacheRow): RawActivity {
  return {
    id: r.stravaActivityId,
    sport_type: r.sportType,
    distance: r.distanceM,
    moving_time: r.movingTimeS,
    total_elevation_gain: r.totalElevationGainM ?? 0,
    start_date: r.startDate,
    start_date_local: r.startDateLocal,
  };
}
