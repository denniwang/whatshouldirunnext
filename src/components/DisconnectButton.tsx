"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";

export function DisconnectButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    if (!confirm("Disconnect Strava and delete your data?")) return;
    setBusy(true);
    try {
      await fetch("/api/auth/disconnect", { method: "POST" });
      await signOut({ redirect: false });
      router.push("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <button onClick={onClick} disabled={busy} className="btn-secondary w-full text-red-400">
      {busy ? "Disconnecting..." : "Disconnect Strava"}
    </button>
  );
}
