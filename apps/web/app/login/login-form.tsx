"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { createBrowserSupabaseClient } from "@/lib/supabase/client";

function MuseMark() {
  return (
    <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 15c4 0 5-7.5 8.7-7.5 2.3 0 2.9 2.8 6.3 2.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M4.5 9c4 0 5 7.5 8.7 7.5 2.3 0 2.9-2.8 6.3-2.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function LoginForm({ accessDenied }: { accessDenied: boolean }) {
  const router = useRouter();
  const supabase = createBrowserSupabaseClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    accessDenied ? "This account does not own a Muse workspace." : "",
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");

    if (accessDenied) await supabase.auth.signOut();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError("Sign-in failed. Check the owner email and password.");
      setBusy(false);
      return;
    }

    router.replace("/");
    router.refresh();
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-4 py-12">
      <div className="auth-orb auth-orb-one" />
      <div className="auth-orb auth-orb-two" />
      <section className="relative z-10 w-full max-w-md rounded-3xl border border-white/10 bg-[#0b111b]/90 p-7 shadow-2xl shadow-black/40 backdrop-blur-xl sm:p-9">
        <div className="grid h-12 w-12 place-items-center rounded-2xl border border-emerald-200/20 bg-emerald-300/10 text-emerald-200">
          <MuseMark />
        </div>
        <p className="mt-8 text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-300/80">Owner console</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-50">Sign in to Muse Hub</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">Private coordination for your workspace, agents, tasks, and handoffs.</p>

        <form className="mt-8 space-y-5" onSubmit={submit}>
          <label className="block text-xs font-medium text-slate-300">
            Owner email
            <input className="form-input mt-2" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label className="block text-xs font-medium text-slate-300">
            Password
            <input className="form-input mt-2" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          {error ? <p className="rounded-xl border border-rose-300/15 bg-rose-300/[0.06] px-3 py-2.5 text-xs text-rose-200" role="alert">{error}</p> : null}
          <button className="primary-button w-full" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
        <p className="mt-6 text-center text-[11px] text-slate-600">No public sign-up · owner access only</p>
      </section>
    </main>
  );
}
