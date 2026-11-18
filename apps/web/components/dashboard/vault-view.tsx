"use client";

import type { Agent, HandoffFile } from "@/lib/dashboard-types";

type VaultViewProps = { files: HandoffFile[]; agents: Agent[]; workspaceId: string };
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
const states: HandoffFile["state"][] = ["uploaded", "picked", "posted", "deleted"];

export function VaultView({ files, agents, workspaceId }: VaultViewProps) {
  return <div className="space-y-5" data-view="vault"><section className="panel flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold text-slate-100">Vault</h2><p className="mt-1 text-xs text-slate-500">Private workspace artifacts with signed owner downloads</p></div><span className="count-pill">{files.length} files</span></section><section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Handoff vault">{files.map((file) => { const agent = agents.find((item) => item.id === file.uploaded_by); return <a className="panel block transition hover:border-sky-300/20 hover:bg-sky-300/[0.03]" href={`/api/owner/files/${file.id}/download?workspace_id=${workspaceId}`} key={file.id}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium text-slate-200">{file.name}</p><p className="mt-1 text-[10px] text-slate-600">{formatBytes(file.size_bytes)} · {file.content_type ?? "artifact"}</p></div><span className="text-[9px] font-semibold uppercase text-sky-300">Download</span></div><div className="mt-4 flex items-center justify-between border-t border-white/[0.06] pt-3"><span className="text-[10px] text-slate-500">{agent?.display_name ?? file.uploaded_by_type}</span><span className="rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[9px] uppercase text-emerald-300">{file.state}</span></div></a>; })}{!files.length ? <p className="panel text-center text-xs text-slate-600">No handoffs uploaded.</p> : null}</section><p className="sr-only">Artifact lifecycle states: {states.join(", ")}.</p></div>;
}
