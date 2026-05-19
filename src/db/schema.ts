import {
  pgTable,
  text,
  integer,
  bigint,
  doublePrecision,
  boolean,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* Auth.js v5 / @auth/drizzle-adapter tables */

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email"),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.providerAccountId] }),
    athleteIdx: index("account_athlete_idx").on(t.providerAccountId),
  })
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.identifier, t.token] }),
  })
);

/* App tables */

export const preferences = pgTable(
  "preferences",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    sports: text("sports").array().notNull(),
    weeklyTargetMinutes: integer("weekly_target_minutes").notNull(),
    weeklyTargetSessions: integer("weekly_target_sessions").notNull(),
    intensityPref: text("intensity_pref").notNull(),
    restDays: integer("rest_days").array().notNull(),
    longSessionDay: integer("long_session_day"),
    maxHr: integer("max_hr"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    intensityCheck: check(
      "intensity_pref_check",
      sql`${t.intensityPref} IN ('easy','balanced','hard')`
    ),
  })
);

export const activityCache = pgTable(
  "activity_cache",
  {
    stravaActivityId: bigint("strava_activity_id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sportType: text("sport_type").notNull(),
    distanceM: doublePrecision("distance_m").notNull(),
    movingTimeS: integer("moving_time_s").notNull(),
    elapsedTimeS: integer("elapsed_time_s").notNull(),
    totalElevationGainM: doublePrecision("total_elevation_gain_m"),
    averageHeartrate: doublePrecision("average_heartrate"),
    averageWatts: doublePrecision("average_watts"),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    startDateLocal: timestamp("start_date_local", { withTimezone: true }).notNull(),
    timezone: text("timezone"),
    trainer: boolean("trainer").notNull().default(false),
    commute: boolean("commute").notNull().default(false),
    private: boolean("private").notNull().default(false),
    name: text("name"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userStartIdx: index("activity_user_start_idx").on(t.userId, t.startDate),
  })
);

export const stravaRateState = pgTable("strava_rate_state", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  lastFullSyncAt: timestamp("last_full_sync_at", { withTimezone: true }),
});

export const stravaAppRateState = pgTable("strava_app_rate_state", {
  id: integer("id").primaryKey().default(1),
  shortUsage: integer("short_usage").notNull().default(0),
  shortLimit: integer("short_limit").notNull().default(100),
  shortWindowStart: timestamp("short_window_start", { withTimezone: true })
    .notNull()
    .defaultNow(),
  dailyUsage: integer("daily_usage").notNull().default(0),
  dailyLimit: integer("daily_limit").notNull().default(1000),
  dailyWindowStart: timestamp("daily_window_start", { withTimezone: true })
    .notNull()
    .defaultNow(),
  retryAfter: timestamp("retry_after", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const suggestionOutcomes = pgTable(
  "suggestion_outcomes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    suggestionId: text("suggestion_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    shownAt: timestamp("shown_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").notNull(),
    actualActivityId: bigint("actual_activity_id", { mode: "number" }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userShownIdx: index("suggestion_outcomes_user_shown_idx").on(t.userId, t.shownAt),
    suggestionIdx: index("suggestion_outcomes_suggestion_idx").on(t.suggestionId),
    outcomeCheck: check(
      "suggestion_outcomes_outcome_check",
      sql`${t.outcome} IN ('completed','modified','skipped','ignored')`
    ),
  })
);

export type Preferences = typeof preferences.$inferSelect;
export type NewPreferences = typeof preferences.$inferInsert;
export type ActivityCacheRow = typeof activityCache.$inferSelect;
export type NewActivityCacheRow = typeof activityCache.$inferInsert;
export type SuggestionOutcomeRow = typeof suggestionOutcomes.$inferSelect;
export type NewSuggestionOutcomeRow = typeof suggestionOutcomes.$inferInsert;
