import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, stravaAppRateState } from "@/db/schema";
import { env } from "@/env";
import { STRAVA_BRAND } from "./brand";
import {
  summaryActivitySchema,
  tokenResponseSchema,
  type SummaryActivity,
  type TokenResponse,
} from "./types";

const REFRESH_BUFFER_SECONDS = 60;

class RateLimitedError extends Error {
  constructor(public retryAfterSeconds: number) {
    super(`Strava rate limit hit; retry after ${retryAfterSeconds}s`);
  }
}
class ScopeError extends Error {
  constructor() {
    super("Missing activity:read_all scope — user must reconnect Strava");
  }
}
export { RateLimitedError, ScopeError };

async function getAccount(userId: string) {
  const rows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, "strava")))
    .limit(1);
  if (rows.length === 0) throw new Error("No Strava account linked");
  return rows[0]!;
}

async function refreshIfNeeded(userId: string) {
  const account = await getAccount(userId);
  const now = Math.floor(Date.now() / 1000);
  if (account.expires_at && account.expires_at - REFRESH_BUFFER_SECONDS > now) {
    return account;
  }
  if (!account.refresh_token) {
    throw new Error("No refresh_token on file; user must reconnect");
  }
  const res = await fetch(`${STRAVA_BRAND.oauthBase}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.AUTH_STRAVA_ID,
      client_secret: env.AUTH_STRAVA_SECRET,
      grant_type: "refresh_token",
      refresh_token: account.refresh_token,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  const token: TokenResponse = tokenResponseSchema.parse(await res.json());
  await db
    .update(accounts)
    .set({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: token.expires_at,
      token_type: token.token_type,
    })
    .where(
      and(
        eq(accounts.provider, "strava"),
        eq(accounts.providerAccountId, account.providerAccountId)
      )
    );
  return { ...account, ...token };
}

async function recordRateHeaders(res: Response) {
  const usage = res.headers.get("x-ratelimit-usage");
  const limit = res.headers.get("x-ratelimit-limit");
  if (!usage || !limit) return;
  const [shortUsage, dailyUsage] = usage.split(",").map((n) => parseInt(n, 10));
  const [shortLimit, dailyLimit] = limit.split(",").map((n) => parseInt(n, 10));
  if (
    Number.isFinite(shortUsage) &&
    Number.isFinite(dailyUsage) &&
    Number.isFinite(shortLimit) &&
    Number.isFinite(dailyLimit)
  ) {
    await db
      .insert(stravaAppRateState)
      .values({
        id: 1,
        shortUsage: shortUsage!,
        shortLimit: shortLimit!,
        dailyUsage: dailyUsage!,
        dailyLimit: dailyLimit!,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: stravaAppRateState.id,
        set: {
          shortUsage: shortUsage!,
          shortLimit: shortLimit!,
          dailyUsage: dailyUsage!,
          dailyLimit: dailyLimit!,
          updatedAt: new Date(),
        },
      });
  }
}

async function preflightRateGate() {
  const rows = await db.select().from(stravaAppRateState).limit(1);
  const state = rows[0];
  if (!state) return;
  if (state.retryAfter && state.retryAfter > new Date()) {
    const wait = Math.ceil((state.retryAfter.getTime() - Date.now()) / 1000);
    throw new RateLimitedError(wait);
  }
  if (state.shortUsage >= Math.floor(state.shortLimit * 0.95)) {
    throw new RateLimitedError(60 * 15);
  }
  if (state.dailyUsage >= Math.floor(state.dailyLimit * 0.95)) {
    throw new RateLimitedError(60 * 60);
  }
}

async function stravaFetch(userId: string, path: string, init?: RequestInit) {
  await preflightRateGate();
  const account = await refreshIfNeeded(userId);
  if (account.scope && !account.scope.includes("activity:read_all")) {
    throw new ScopeError();
  }
  const url = path.startsWith("http") ? path : `${STRAVA_BRAND.apiBase}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${account.access_token}`,
    },
    cache: "no-store",
  });
  await recordRateHeaders(res);
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "900", 10);
    await db
      .insert(stravaAppRateState)
      .values({
        id: 1,
        retryAfter: new Date(Date.now() + retryAfter * 1000),
      })
      .onConflictDoUpdate({
        target: stravaAppRateState.id,
        set: { retryAfter: new Date(Date.now() + retryAfter * 1000) },
      });
    throw new RateLimitedError(retryAfter);
  }
  if (!res.ok) {
    throw new Error(`Strava ${res.status}: ${await res.text()}`);
  }
  return res;
}

export async function fetchAthleteActivities(
  userId: string,
  afterUnix: number
): Promise<SummaryActivity[]> {
  const all: SummaryActivity[] = [];
  for (let page = 1; page <= 3; page++) {
    const res = await stravaFetch(
      userId,
      `/athlete/activities?per_page=100&after=${afterUnix}&page=${page}`
    );
    const json = (await res.json()) as unknown[];
    if (!Array.isArray(json) || json.length === 0) break;
    for (const raw of json) {
      const parsed = summaryActivitySchema.safeParse(raw);
      if (parsed.success) all.push(parsed.data);
    }
    if (json.length < 100) break;
  }
  return all;
}

export async function deauthorize(userId: string) {
  try {
    const account = await refreshIfNeeded(userId);
    await fetch(`${STRAVA_BRAND.oauthBase}/deauthorize`, {
      method: "POST",
      headers: { authorization: `Bearer ${account.access_token}` },
    });
  } catch {
    // best-effort; we still wipe locally
  }
}
