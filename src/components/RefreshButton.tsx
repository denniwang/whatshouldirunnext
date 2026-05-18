"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function RefreshButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const onClick = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/activities/refresh", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-stretch">
      <button onClick={onClick} disabled={busy} className="btn-secondary">
        {busy ? "Refreshing..." : "Refresh"}
      </button>
      {err && <p className="mt-1 text-xs text-red-500">{err}</p>}
    </div>
  );
}
