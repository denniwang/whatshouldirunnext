import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { ConnectStravaButton } from "@/components/ConnectStravaButton";
import { PoweredByStrava } from "@/components/PoweredByStrava";
import { db } from "@/db/client";
import { preferences } from "@/db/schema";
import { eq } from "drizzle-orm";

export default async function HomePage() {
  const session = await auth();
  if (session?.user?.id) {
    const rows = await db
      .select()
      .from(preferences)
      .where(eq(preferences.userId, session.user.id))
      .limit(1);
    redirect(rows.length === 0 ? "/onboarding" : "/dashboard");
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col px-5 py-10">
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight">whatshouldirunnext</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Suggestions for your next workout, based on your real Strava history.
        </p>
      </header>

      <section className="space-y-5 mb-10">
        <Feature title="Connect Strava">
          Read your last 30 days of activity. Tokens stay on the server.
        </Feature>
        <Feature title="Set your preferences">
          Sports, weekly target, intensity, rest days — once, and you&apos;re done.
        </Feature>
        <Feature title="See 3-5 suggestions">
          Volume gap, recovery, long sessions, cross-training — derived from rules,
          not a black box.
        </Feature>
      </section>

      <div className="mt-auto flex flex-col items-center gap-3">
        <ConnectStravaButton />
        <p className="text-xs text-[var(--muted)]">
          We never post to Strava or alter your data.
        </p>
      </div>
      <PoweredByStrava />
    </main>
  );
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-[var(--muted)]">{children}</p>
    </div>
  );
}
