"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { bundledSkills, starterPresets, type BundledSkill } from "@muse/skills";
import { configurationSyncBadge, emptyConfiguration, emptyPermissions, estimateTokenCount, PERMISSION_KEYS, selectPreset, type DesiredConfiguration, type Permissions, type SkillChoice } from "@/lib/configuration-contract";

type Agent = { id: string; display_name: string; status: string };
type RoleVersion = { role_id: string; version: number; name: string; description: string; instructions: string; skills: SkillChoice[]; permissions: Permissions };
type WorkspaceRole = { id: string; name: string; description: string; current_version: number };
type CustomSkill = { skill_id: string; version: number; name: string; description: string; content: string };
type RolesResponse = { roles: WorkspaceRole[]; versions: RoleVersion[] };
type SkillsResponse = { custom_skills: CustomSkill[] };
type ConfigurationResponse = { agent_id: string; desired_revision: number; applied_revision: number; sync_revision?: number; sync_status?: string; sync_error?: string | null; configuration: DesiredConfiguration; sync_badge: string };
type SkillRow = { source: "bundled" | "custom"; id: string; version: string | number; name: string; description: string; tokens: number };
class ApiFailure extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json", ...options?.headers } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new ApiFailure(payload?.error?.message ?? "The request could not be completed. Please retry.", response.status, payload?.error?.code ?? "REQUEST_FAILED");
  return payload as T;
}
const permissionNames: Record<typeof PERMISSION_KEYS[number], string> = {
  file_read: "Read files", file_write: "Write files", code_execute: "Execute code", network_read: "Read network resources", external_send: "Send externally", deploy: "Deploy", delegate: "Delegate", financial_action: "Financial actions",
};
const newSkill = "---\nname: custom-skill\ndescription: Describe when to use this skill.\n---\n\n# Custom skill\n\n## Procedure\n\n- Describe the procedure, boundaries and verification.\n";

export function AgentConfigurationPanel({ workspaceId, agents, agentLimit, initialAgentId, setupRequired }: { workspaceId: string; agents: Agent[]; agentLimit: number; initialAgentId?: string; setupRequired: boolean }) {
  const firstId = agents.some(a => a.id === initialAgentId) ? initialAgentId! : agents[0]?.id ?? "";
  const [agentId, setAgentId] = useState(firstId);
  const [mobileEditor, setMobileEditor] = useState(!!initialAgentId && !!firstId);
  const [roles, setRoles] = useState<RolesResponse>({ roles: [], versions: [] });
  const [customSkills, setCustomSkills] = useState<CustomSkill[]>([]);
  const [loaded, setLoaded] = useState<ConfigurationResponse | null>(null);
  const [draft, setDraft] = useState<DesiredConfiguration>(emptyConfiguration);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(setupRequired);
  const [verificationNeeded, setVerificationNeeded] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [roleName, setRoleName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [skillContent, setSkillContent] = useState(newSkill);
  const [editingSkill, setEditingSkill] = useState<CustomSkill | null>(null);
  const workspaceQuery = `workspace_id=${encodeURIComponent(workspaceId)}`;
  const configurationUrl = (id: string) => `/api/owner/agents/${encodeURIComponent(id)}/configuration?${workspaceQuery}`;
  const dirty = !!loaded && JSON.stringify(draft) !== JSON.stringify(loaded.configuration);
  const activeAgent = agents.find(a => a.id === agentId);
  const selectedRole = draft.role?.kind === "custom" ? roles.versions.find(v => v.role_id === draft.role!.id && v.version === draft.role!.version) : undefined;

  function report(failure: unknown) {
    setError(failure instanceof Error ? failure.message : "The request could not be completed.");
    if (failure instanceof ApiFailure && failure.code === "CONFIGURATION_SETUP_REQUIRED") setNeedsSetup(true);
    if (failure instanceof ApiFailure && failure.status === 409) setConflict(true);
  }
  async function refreshTemplates() {
    const [roleData, skillData] = await Promise.all([
      api<RolesResponse>(`/api/owner/roles?${workspaceQuery}`), api<SkillsResponse>(`/api/owner/skills?${workspaceQuery}`),
    ]);
    setRoles(roleData); setCustomSkills(skillData.custom_skills); setNeedsSetup(false);
    return { roleData, skillData };
  }
  useEffect(() => {
    let cancelled = false;
    setLoaded(null); setDraft(emptyConfiguration()); setError(""); setNotice(""); setConflict(false); setVerificationNeeded(false);
    if (!agentId) return;
    setLoading(true);
    Promise.all([api<RolesResponse>(`/api/owner/roles?${workspaceQuery}`), api<SkillsResponse>(`/api/owner/skills?${workspaceQuery}`), api<ConfigurationResponse>(configurationUrl(agentId))])
      .then(([roleData, skillData, configuration]) => {
        if (cancelled) return;
        setRoles(roleData); setCustomSkills(skillData.custom_skills); setLoaded(configuration); setDraft(configuration.configuration); setNeedsSetup(false);
      }).catch(failure => { if (!cancelled) report(failure); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // The workspace is fixed for this mounted owner page; selecting an agent loads only, never writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, workspaceId]);

  // Badge-only refresh: never overwrite the owner's draft or its CAS base revision.
  useEffect(() => {
    if (!agentId || !loaded || loading || busy || needsSetup || conflict) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const fresh = await api<ConfigurationResponse>(configurationUrl(agentId));
        if (cancelled) return;
        if (fresh.desired_revision !== loaded.desired_revision) {
          setConflict(true); setNotice("Configuration changed elsewhere. Reload before saving; your draft is preserved."); return;
        }
        setLoaded(previous => previous && previous.desired_revision === fresh.desired_revision ? { ...previous, applied_revision: fresh.applied_revision, sync_revision: fresh.sync_revision, sync_status: fresh.sync_status, sync_error: fresh.sync_error, sync_badge: fresh.sync_badge } : previous);
      } catch { /* Transient badge refresh errors must not interrupt editing. */ }
    }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, loaded?.desired_revision, loading, busy, needsSetup, conflict]);

  const skillRows = useMemo(() => {
    const rows: SkillRow[] = bundledSkills.map((s: BundledSkill) => ({ source: "bundled", id: s.id, version: s.version, name: s.name, description: s.description, tokens: s.estimated_tokens }));
    const latest = new Map<string, CustomSkill>();
    for (const skill of customSkills) if (!latest.has(skill.skill_id) || latest.get(skill.skill_id)!.version < skill.version) latest.set(skill.skill_id, skill);
    for (const [id, current] of latest) {
      const pinned = draft.skills.find(s => s.source === "custom" && s.id === id);
      const skill = customSkills.find(s => s.skill_id === id && s.version === pinned?.version) ?? current;
      rows.push({ source: "custom", id, version: skill.version, name: skill.name, description: skill.description, tokens: estimateTokenCount(skill.content) });
    }
    return rows;
  }, [customSkills, draft.skills]);
  const tokenEstimate = useMemo(() => {
    const roleTokens = draft.role?.kind === "preset" ? starterPresets.find(p => p.id === draft.role!.id)?.estimated_tokens ?? 0 : estimateTokenCount(selectedRole?.instructions ?? "");
    return roleTokens + estimateTokenCount(draft.instructions) + draft.skills.filter(s => s.enabled).reduce((total, s) => total + (skillRows.find(row => row.source === s.source && row.id === s.id)?.tokens ?? 0), 0);
  }, [draft, skillRows, selectedRole]);
  function pickAgent(id: string) {
    if (busy || (dirty && !window.confirm("Discard this unsaved configuration draft?"))) return;
    setAgentId(id); setMobileEditor(true);
  }
  function pickRole(value: string) {
    setError(""); setNotice("");
    if (!value) { setDraft(previous => ({ ...previous, role: null })); return; }
    const [kind, id, version] = value.split(":");
    if (kind === "preset") {
      const preset = starterPresets.find(p => p.id === id && p.version === version);
      if (preset) setDraft(selectPreset(preset, bundledSkills));
    } else {
      const role = roles.versions.find(v => v.role_id === id && v.version === Number(version));
      if (role) setDraft({ role: { kind: "custom", id: role.role_id, version: role.version }, skills: structuredClone(role.skills), instructions: "", permissions: { ...emptyPermissions(), ...role.permissions } });
    }
  }
  function toggleSkill(row: SkillRow, enabled: boolean, customVersion?: number) {
    setDraft(previous => {
      const version = customVersion ?? row.version;
      const choice: SkillChoice = row.source === "bundled" ? { source: "bundled", id: row.id, version: String(version), enabled } : { source: "custom", id: row.id, version: Number(version), enabled };
      return { ...previous, skills: [...previous.skills.filter(s => !(s.source === row.source && s.id === row.id)), choice] };
    });
  }
  async function reloadConfiguration() {
    if (!agentId || busy || (dirty && !window.confirm("Discard the draft and reload the saved revision?"))) return;
    setBusy(true); setError("");
    try {
      await refreshTemplates();
      const configuration = await api<ConfigurationResponse>(configurationUrl(agentId));
      setLoaded(configuration); setDraft(configuration.configuration); setConflict(false); setVerificationNeeded(false); setNotice("Saved revision reloaded.");
    } catch (failure) { report(failure); } finally { setBusy(false); }
  }
  async function saveConfiguration() {
    if (!loaded || busy || verificationNeeded) return;
    setBusy(true); setError(""); setNotice("");
    let written = false;
    try {
      await api<unknown>(configurationUrl(agentId), { method: "PUT", body: JSON.stringify({ workspace_id: workspaceId, base_revision: loaded.desired_revision, ...draft }) });
      written = true;
      // Read back the exact agent before displaying a successful save or advancing the base revision.
      const confirmed = await api<ConfigurationResponse>(configurationUrl(agentId));
      if (confirmed.desired_revision <= loaded.desired_revision) throw new Error("The saved revision could not be confirmed. Reload before saving again.");
      setLoaded(confirmed); setDraft(confirmed.configuration); setConflict(false); setNotice("Configuration saved. Bridge sync is pending; no runtime actions were executed.");
    } catch (failure) {
      if (written) { setVerificationNeeded(true); setError("Save was accepted, but read-back confirmation failed. Reload the saved revision before another write."); }
      else report(failure);
    } finally { setBusy(false); }
  }
  function cancelDraft() {
    if (!loaded || busy) return;
    setDraft(structuredClone(loaded.configuration)); setError(""); setNotice("Draft cancelled; saved configuration unchanged.");
  }
  async function saveRoleTemplate(update: boolean) {
    if (busy || !loaded) return;
    const role = update ? selectedRole : undefined;
    if (update && !role) return;
    setBusy(true); setError(""); setNotice(""); let written = false;
    try {
      const body = { workspace_id: workspaceId, name: roleName, description: roleDescription, instructions: [selectedRole?.instructions ?? "", draft.instructions].filter(Boolean).join("\n\n"), skills: draft.skills, permissions: draft.permissions, ...(role ? { base_version: role.version } : {}) };
      const result = await api<{ role: { id?: string; role_id?: string; version: number; current_version?: number } }>(role ? `/api/owner/roles/${role.role_id}` : "/api/owner/roles", { method: role ? "PATCH" : "POST", body: JSON.stringify(body) });
      written = true;
      const { roleData } = await refreshTemplates();
      const id = result.role.role_id ?? result.role.id ?? role?.role_id;
      const version = result.role.version ?? result.role.current_version;
      if (!roleData.versions.some(v => v.role_id === id && v.version === version)) throw new Error("The new role version could not be confirmed.");
      setNotice("Custom role version saved and verified. Select it explicitly to assign it; existing agents and pinned versions are unchanged."); setRoleName(""); setRoleDescription("");
    } catch (failure) { if (written) setError("Role write accepted, but confirmation failed. Reload templates before another write."); else report(failure); }
    finally { setBusy(false); }
  }
  async function saveSkill(event: FormEvent) {
    event.preventDefault(); if (busy || !loaded) return;
    setBusy(true); setError(""); setNotice(""); let written = false;
    try {
      const result = await api<{ skill: { skill_id: string; version: number } }>("/api/owner/skills", { method: "POST", body: JSON.stringify({ workspace_id: workspaceId, content: skillContent, ...(editingSkill ? { skill_id: editingSkill.skill_id, base_version: editingSkill.version } : {}) }) });
      written = true;
      const { skillData } = await refreshTemplates();
      if (!skillData.custom_skills.some(s => s.skill_id === result.skill.skill_id && s.version === result.skill.version)) throw new Error("The new skill version could not be confirmed.");
      setNotice("SKILL.md version saved and verified. Enable it explicitly; no agent was changed."); setEditingSkill(null); setSkillContent(newSkill);
    } catch (failure) { if (written) setError("Skill write accepted, but confirmation failed. Reload templates before another write."); else report(failure); }
    finally { setBusy(false); }
  }

  return <>
    {needsSetup && <section className="admin-banner admin-warning" role="status"><h2>Database setup required</h2><p>Run <code>supabase/migrations/002_agent_configuration.sql</code> in your Supabase SQL editor, then reload this page. This Stage A panel stays unavailable until setup is verified. No defaults have been assigned.</p><button className="admin-button" onClick={reloadConfiguration} disabled={busy || !agentId}>Verify setup again</button></section>}
    <div className="admin-workspace min-w-0" data-mobile-editor={mobileEditor ? "true" : "false"}>
      <aside className="admin-sidebar" aria-label="Agent slots">
        <h2>Fleet slots</h2><p className="admin-muted">Any role can be assigned to any linked slot. Presets are optional, never automatic.</p>
        {Array.from({ length: Math.min(10, agentLimit || 10) }, (_, index) => {
          const agent = agents[index];
          return agent ? <button key={agent.id} type="button" className={`admin-agent ${agentId === agent.id ? "is-active" : ""}`} aria-pressed={agentId === agent.id} disabled={busy} onClick={() => pickAgent(agent.id)}><span className="admin-slot">Slot {index + 1}</span><strong>{agent.display_name}</strong><span className="admin-muted">{agent.status} · {agentId === agent.id && loaded ? configurationSyncBadge(loaded.desired_revision, loaded.applied_revision, loaded.sync_status, loaded.sync_revision ?? 0) : "Select to inspect configuration"}</span></button> : <div key={`empty-${index}`} className="admin-agent admin-empty"><span className="admin-slot">Slot {index + 1}</span><strong>Not linked</strong><span className="admin-muted">Starts Unconfigured when linked.</span></div>;
        })}
      </aside>
      <section className="admin-editor" aria-label="Role and skills editor" aria-busy={loading || busy}>
        <button type="button" className="admin-button admin-mobile-back" onClick={() => setMobileEditor(false)} disabled={busy}>← All slots</button>
        <div className="admin-editor-heading"><div className="min-w-0"><h2>{activeAgent?.display_name ?? "Choose a linked agent"}</h2><p className="admin-muted">Desired state only. Register, heartbeat and inbox contracts are unchanged.</p></div><span className="admin-sync">{loaded ? configurationSyncBadge(loaded.desired_revision, loaded.applied_revision, loaded.sync_status, loaded.sync_revision ?? 0) : "Unconfigured"}</span></div>
        {!agentId && <p className="admin-banner">Link an agent from Fleet first. Linking does not assign a role, skills or action permissions.</p>}
        {loading && <p role="status" className="admin-banner">Loading owner configuration…</p>}
        {error && <div className="admin-banner admin-warning" role="alert"><p>{error}</p>{(conflict || verificationNeeded || !loaded) && <button className="admin-button" onClick={reloadConfiguration} disabled={busy || !agentId}>Reload saved configuration</button>}</div>}
        {notice && <p className="admin-banner" role="status">{notice}</p>}
        <fieldset disabled={!loaded || needsSetup || loading || busy} className="admin-fields">
          <div className="admin-metrics"><div><span>Desired revision</span><strong>{loaded?.desired_revision ?? 0}</strong></div><div><span>Applied revision</span><strong>{loaded?.applied_revision ?? 0}</strong></div><div><span>Token estimate</span><strong>~{tokenEstimate.toLocaleString()}</strong></div></div>
          <p className="admin-muted admin-small">Token estimate is approximate (characters ÷ 4), not a model tokenizer or usage bill.</p>
          <label className="admin-field">Role template<select aria-label="Role template" value={draft.role ? `${draft.role.kind === "preset" ? "preset" : "custom"}:${draft.role.id}:${draft.role.version}` : ""} onChange={event => pickRole(event.target.value)}><option value="">No role — Unconfigured / skill-only</option><optgroup label="Optional starter presets (1–10)">{starterPresets.map((preset, index) => <option key={preset.id} value={`preset:${preset.id}:${preset.version}`}>{index + 1}. {preset.name} · v{preset.version}</option>)}</optgroup><optgroup label="Custom roles — immutable versions">{roles.versions.map(role => <option key={`${role.role_id}:${role.version}`} value={`custom:${role.role_id}:${role.version}`}>{role.name} · v{role.version}{roles.roles.find(r => r.id === role.role_id)?.current_version === role.version ? " (current)" : " (pinned)"}</option>)}</optgroup></select></label>
          <p className="admin-muted admin-small">Choosing a template explicitly replaces this draft&apos;s skill selection and desired permissions. It never saves or changes another slot.</p>
          {selectedRole?.instructions && <details className="admin-section"><summary>Selected custom-role instructions (pinned v{selectedRole.version})</summary><pre className="admin-role-preview">{selectedRole.instructions}</pre></details>}
          <section className="admin-section"><h3>Individual skills</h3><label className="admin-field">Filter skills<input aria-label="Filter skills" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name or description" /></label><div className="admin-skill-list">{skillRows.filter(row => `${row.name} ${row.description}`.toLowerCase().includes(search.toLowerCase())).map(row => {
            const selected = draft.skills.find(s => s.source === row.source && s.id === row.id);
            const customVersions = customSkills.filter(s => s.skill_id === row.id);
            return <div key={`${row.source}:${row.id}`} className="admin-skill-row"><label className="admin-check"><input type="checkbox" aria-label={`Enable ${row.name}`} checked={selected?.enabled ?? false} onChange={event => toggleSkill(row, event.target.checked)} /><span><strong>{row.name}</strong><span className="admin-muted">{row.description}</span><small>{row.source} · v{selected?.version ?? row.version} · ~{row.tokens.toLocaleString()} tokens</small></span></label>{row.source === "custom" && <div className="admin-skill-actions"><select aria-label={`Version of ${row.name}`} value={String(selected?.version ?? row.version)} onChange={event => toggleSkill(row, selected?.enabled ?? false, Number(event.target.value))}>{customVersions.map(skill => <option key={skill.version} value={skill.version}>v{skill.version}</option>)}</select><button type="button" className="admin-button admin-small" onClick={() => { const skill = customVersions.find(s => s.version === (selected?.version ?? row.version)); if (skill) { setEditingSkill(skill); setSkillContent(skill.content); } }}>Edit SKILL.md</button></div>}</div>;
          })}</div><p className="admin-muted admin-small">OFF selections stay version-pinned. You can mix skills from any preset or your workspace&apos;s custom bundles.</p></section>
          <section className="admin-section"><h3>Action permissions</h3><p className="admin-muted">Desired flags only. Stage B is required for runtime enforcement; saving here never grants or executes an action.</p><div className="admin-permissions">{PERMISSION_KEYS.map(key => <label key={key} className="admin-check"><input type="checkbox" aria-label={permissionNames[key]} checked={draft.permissions[key]} onChange={event => setDraft(previous => ({ ...previous, permissions: { ...previous.permissions, [key]: event.target.checked } }))} /><span>{permissionNames[key]}</span></label>)}</div></section>
          <label className="admin-field">Additional instructions<textarea aria-label="Additional instructions" rows={6} maxLength={20000} value={draft.instructions} onChange={event => setDraft(previous => ({ ...previous, instructions: event.target.value }))} placeholder="Optional owner-authored guidance; saved as text, never executed by this panel." /></label>
          <details className="admin-section"><summary>Custom role editor</summary><p className="admin-muted">Store this draft as a reusable immutable role version. Saving a template never assigns it to an agent.</p><label className="admin-field">Role name<input aria-label="Custom role name" maxLength={120} value={roleName} onChange={event => setRoleName(event.target.value)} /></label><label className="admin-field">Description<textarea aria-label="Custom role description" rows={2} maxLength={2000} value={roleDescription} onChange={event => setRoleDescription(event.target.value)} /></label><div className="admin-inline-actions"><button type="button" className="admin-button" disabled={!roleName.trim()} onClick={() => saveRoleTemplate(false)}>Create custom role from draft</button><button type="button" className="admin-button" disabled={!selectedRole || !roleName.trim()} onClick={() => saveRoleTemplate(true)}>Save new version of selected role</button></div></details>
          <details className="admin-section"><summary>Custom SKILL.md bundle editor</summary><form onSubmit={saveSkill}><p className="admin-muted">{editingSkill ? `Editing ${editingSkill.name} v${editingSkill.version}; saving creates a new immutable version.` : "Create a private workspace bundle with scalar name and description frontmatter. Markdown is stored as text; it is not executed or rendered as HTML."}</p><label className="admin-field">SKILL.md<textarea className="admin-code" aria-label="Custom SKILL.md" rows={12} maxLength={100000} spellCheck={false} value={skillContent} onChange={event => setSkillContent(event.target.value)} /></label><div className="admin-inline-actions"><button className="admin-button" type="submit">{editingSkill ? "Save new SKILL.md version" : "Create SKILL.md bundle"}</button><button type="button" className="admin-button" onClick={() => { setEditingSkill(null); setSkillContent(newSkill); }}>New blank bundle</button></div></form></details>
          <button type="button" className="admin-button" onClick={() => setDraft(emptyConfiguration())}>Clear draft to neutral / Unconfigured</button>
        </fieldset>
        <footer className="admin-save-bar"><span>{dirty ? "Unsaved changes" : "No unsaved changes"} · {loaded ? `base_revision ${loaded.desired_revision}` : "No revision loaded"}</span><div><button className="admin-button" type="button" onClick={cancelDraft} disabled={!loaded || busy || !dirty}>Cancel</button><button className="admin-button admin-primary" type="button" onClick={saveConfiguration} disabled={!loaded || needsSetup || loading || busy || conflict || verificationNeeded || !dirty}>{busy ? "Working…" : "Save configuration"}</button></div></footer>
      </section>
    </div>
  </>;
}
