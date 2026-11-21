"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./pack-management-panel.module.css";

type CatalogPack = {
  pack_id: string;
  title?: string | null;
  name?: string | null;
  summary: string;
  latest_version: string;
  purchase_url: string;
};
type PackState = { pack_id: string; status: string; pack_version?: string | null; desired_revision?: number; applied_revision?: number };
type CatalogResponse = { packs: CatalogPack[] };
type StatusResponse = { packs: PackState[] };
type ApiError = { error?: string; message?: string };

function friendlyStatus(status: string) {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function packTitle(pack: CatalogPack) {
  return pack.title?.trim() || pack.name?.trim() || pack.pack_id;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const payload = await response.json().catch(() => ({})) as T & ApiError;
  if (!response.ok) throw new Error(payload.message || "The pack service could not complete this request.");
  return payload;
}

export function PackManagementPanel({ workspaceId }: { workspaceId: string }) {
  const [catalog, setCatalog] = useState<CatalogPack[]>([]);
  const [states, setStates] = useState<PackState[]>([]);
  const [licenses, setLicenses] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const query = `?workspace_id=${encodeURIComponent(workspaceId)}`;
      const [available, installed] = await Promise.all([
        api<CatalogResponse>(`/api/packs/catalog${query}`),
        api<StatusResponse>(`/api/packs/status${query}`),
      ]);
      setCatalog(available.packs ?? []); setStates(installed.packs ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The pack library could not be loaded."); }
    finally { setLoading(false); }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);
  const stateByPack = useMemo(() => new Map(states.map((state) => [state.pack_id, state])), [states]);

  async function activate(pack: CatalogPack) {
    const licenseKey = licenses[pack.pack_id]?.trim();
    if (!licenseKey) { setError("Paste the Gumroad license key before activating this pack."); return; }
    setBusy(`${pack.pack_id}:activate`); setError(null); setNotice(null);
    try {
      await api("/api/packs/activate", { method: "POST", body: JSON.stringify({ workspace_id: workspaceId, pack_id: pack.pack_id, license_key: licenseKey }) });
      setLicenses((current) => ({ ...current, [pack.pack_id]: "" }));
      setNotice(`${packTitle(pack)} is licensed for this workspace.`); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "License activation failed."); }
    finally { setBusy(null); }
  }

  async function install(pack: CatalogPack) {
    setBusy(`${pack.pack_id}:install`); setError(null); setNotice(null);
    try {
      await api("/api/packs/install", { method: "POST", body: JSON.stringify({ workspace_id: workspaceId, pack_id: pack.pack_id }) });
      setNotice(`${packTitle(pack)} is installed and synchronized.`); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Pack installation failed."); }
    finally { setBusy(null); }
  }

  if (loading && catalog.length === 0) return <section className={styles.state} aria-live="polite">Loading pack library…</section>;
  return <section className={styles.library} aria-labelledby="pack-library-title">
    <div className={styles.intro}><div><span className={styles.kicker}>Commerce</span><h2 id="pack-library-title">Available packs</h2><p>Activate a purchase once, then install its roles, skills, and workflow into this workspace.</p></div><button className={styles.refresh} type="button" onClick={() => void load()} disabled={loading || !!busy}>Refresh</button></div>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {!loading && catalog.length === 0 ? <div className={styles.state}>No published packs are available.</div> : <div className={styles.grid}>{catalog.map((pack) => {
      const current = stateByPack.get(pack.pack_id);
      const status = current?.status ?? "unlicensed";
      const canInstall = status !== "unlicensed" && status !== "revoked";
      const activating = busy === `${pack.pack_id}:activate`;
      const installing = busy === `${pack.pack_id}:install`;
      return <article className={styles.card} key={pack.pack_id}>
        <div className={styles.cardTop}><div><span className={styles.version}>v{pack.latest_version}</span><h3>{packTitle(pack)}</h3></div><span className={`${styles.badge} ${status === "applied" ? styles.ready : status === "unlicensed" ? styles.locked : styles.active}`}>{friendlyStatus(status)}</span></div>
        <p className={styles.summary}>{pack.summary}</p>
        {current && status !== "unlicensed" && <dl className={styles.meta}><div><dt>Desired revision</dt><dd>{current.desired_revision ?? 0}</dd></div><div><dt>Applied revision</dt><dd>{current.applied_revision ?? 0}</dd></div></dl>}
        <div className={styles.actions}>
          <label htmlFor={`license-${pack.pack_id}`}>Gumroad license key</label>
          <div className={styles.activateRow}><input id={`license-${pack.pack_id}`} type="password" autoComplete="off" spellCheck={false} value={licenses[pack.pack_id] ?? ""} onChange={(event) => setLicenses((currentLicenses) => ({ ...currentLicenses, [pack.pack_id]: event.target.value }))} placeholder="Paste license key" disabled={!!busy} /><button type="button" onClick={() => void activate(pack)} disabled={!!busy || !(licenses[pack.pack_id]?.trim())}>{activating ? "Activating…" : "Activate"}</button></div>
          <button className={styles.install} type="button" onClick={() => void install(pack)} disabled={!!busy || !canInstall}>{installing ? "Installing…" : status === "applied" ? "Sync installation" : "Install pack"}</button>
          {status === "unlicensed" && pack.purchase_url && <a className={styles.purchase} href={pack.purchase_url} target="_blank" rel="noreferrer">Buy on Gumroad <span aria-hidden="true">↗</span></a>}
        </div>
      </article>;
    })}</div>}
  </section>;
}
