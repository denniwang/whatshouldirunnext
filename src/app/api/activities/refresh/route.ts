import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { syncIfStale } from "@/lib/strava/sync";
import { RateLimitedError, ScopeError } from "@/lib/strava/client";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return new NextResponse("unauthorized", { status: 401 });
  try {
    const result = await syncIfStale(session.user.id, false);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof RateLimitedError) {
      return NextResponse.json(
        { error: "rate_limited", retryAfterSeconds: e.retryAfterSeconds },
        { status: 429 }
      );
    }
    if (e instanceof ScopeError) {
      return NextResponse.json({ error: "scope" }, { status: 403 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "sync_failed" },
      { status: 500 }
    );
  }
}
