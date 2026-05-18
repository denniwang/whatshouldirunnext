import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db/client";
import { preferences } from "@/db/schema";

const preferencesSchema = z.object({
  sports: z.array(z.string().min(1)).min(1),
  weeklyTargetMinutes: z.number().int().min(15).max(2000),
  weeklyTargetSessions: z.number().int().min(1).max(14),
  intensityPref: z.enum(["easy", "balanced", "hard"]),
  restDays: z.array(z.number().int().min(1).max(7)),
  longSessionDay: z.number().int().min(1).max(7).nullable(),
  maxHr: z.number().int().min(100).max(230).nullable(),
  notes: z.string().max(2000).nullable().optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return new NextResponse("unauthorized", { status: 401 });
  const parsed = preferencesSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(parsed.error.flatten(), { status: 400 });
  }
  const v = parsed.data;
  await db
    .insert(preferences)
    .values({
      userId: session.user.id,
      sports: v.sports,
      weeklyTargetMinutes: v.weeklyTargetMinutes,
      weeklyTargetSessions: v.weeklyTargetSessions,
      intensityPref: v.intensityPref,
      restDays: v.restDays,
      longSessionDay: v.longSessionDay,
      maxHr: v.maxHr,
      notes: v.notes ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: preferences.userId,
      set: {
        sports: v.sports,
        weeklyTargetMinutes: v.weeklyTargetMinutes,
        weeklyTargetSessions: v.weeklyTargetSessions,
        intensityPref: v.intensityPref,
        restDays: v.restDays,
        longSessionDay: v.longSessionDay,
        maxHr: v.maxHr,
        notes: v.notes ?? null,
        updatedAt: new Date(),
      },
    });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return new NextResponse("unauthorized", { status: 401 });
  const parsed = preferencesSchema.partial().safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(parsed.error.flatten(), { status: 400 });
  }
  const v = parsed.data;
  await db
    .update(preferences)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(preferences.userId, session.user.id));
  return NextResponse.json({ ok: true });
}
