"use client";

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-md px-5 py-10">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-[var(--muted)]">{error.message}</p>
      <button onClick={reset} className="btn-primary mt-6">
        Try again
      </button>
    </main>
  );
}
