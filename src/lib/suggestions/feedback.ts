export type SuggestionOutcomeKind = "completed" | "modified" | "skipped" | "ignored";

export interface SuggestionOutcome {
  suggestion_id: string;
  user_id: string;
  shown_at: Date;
  outcome: SuggestionOutcomeKind;
  actual_activity_id?: number;
  notes?: string;
}

/**
 * Pluggable backing store. Production wires the Drizzle-backed store below;
 * tests inject an in-memory implementation via setFeedbackStore().
 */
export interface FeedbackStore {
  record(o: SuggestionOutcome): Promise<void>;
  recent(userId: string, since: Date): Promise<SuggestionOutcome[]>;
}

// Lazy-loaded so importing this module doesn't trigger @/db/client env
// validation in environments that don't need DB access (e.g., tests using
// the in-memory store).
const drizzleStore: FeedbackStore = {
  async record(o: SuggestionOutcome): Promise<void> {
    const { db } = await import("@/db/client");
    const { suggestionOutcomes } = await import("@/db/schema");
    await db.insert(suggestionOutcomes).values({
      suggestionId: o.suggestion_id,
      userId: o.user_id,
      shownAt: o.shown_at,
      outcome: o.outcome,
      actualActivityId: o.actual_activity_id ?? null,
      notes: o.notes ?? null,
    });
  },
  async recent(userId: string, since: Date): Promise<SuggestionOutcome[]> {
    const { db } = await import("@/db/client");
    const { suggestionOutcomes } = await import("@/db/schema");
    const { and, desc, eq, gte } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(suggestionOutcomes)
      .where(and(eq(suggestionOutcomes.userId, userId), gte(suggestionOutcomes.shownAt, since)))
      .orderBy(desc(suggestionOutcomes.shownAt));
    return rows.map((r) => ({
      suggestion_id: r.suggestionId,
      user_id: r.userId,
      shown_at: r.shownAt,
      outcome: r.outcome as SuggestionOutcomeKind,
      actual_activity_id: r.actualActivityId ?? undefined,
      notes: r.notes ?? undefined,
    }));
  },
};

let currentStore: FeedbackStore = drizzleStore;

export function setFeedbackStore(store: FeedbackStore | null): void {
  currentStore = store ?? drizzleStore;
}

export async function recordOutcome(outcome: SuggestionOutcome): Promise<void> {
  return currentStore.record(outcome);
}

export async function getRecentOutcomes(
  userId: string,
  days: number
): Promise<SuggestionOutcome[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  return currentStore.recent(userId, since);
}

export function createInMemoryFeedbackStore(): FeedbackStore & { all(): SuggestionOutcome[] } {
  const rows: SuggestionOutcome[] = [];
  return {
    async record(o) {
      rows.push({ ...o });
    },
    async recent(userId, since) {
      return rows
        .filter((r) => r.user_id === userId && r.shown_at >= since)
        .sort((a, b) => b.shown_at.getTime() - a.shown_at.getTime());
    },
    all() {
      return [...rows];
    },
  };
}

// TODO(feedback): Outcomes are captured but not yet consumed by the engine.
// Next steps once enough data accumulates:
//   (a) adjust rule weights based on completion vs. skip ratios per type;
//   (b) flip into a conservative mode after N repeated skips in a row;
//   (c) detect systematic "modified shorter than suggested" patterns and
//       lower the default duration target for that user.
