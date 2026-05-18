export default function Loading() {
  return (
    <main className="mx-auto max-w-md px-5 py-6">
      <div className="h-7 w-32 animate-pulse rounded bg-[var(--card)]" />
      <div className="mt-6 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-[var(--card)]" />
        ))}
      </div>
    </main>
  );
}
