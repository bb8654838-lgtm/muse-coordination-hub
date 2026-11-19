import "server-only";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { bundledSkills, starterPresets } from "./index";
const roots = [path.resolve(process.cwd(), "packages/skills"), path.resolve(process.cwd(), "../../packages/skills")];
async function registryRoot(): Promise<string> {
  for (const root of roots) { try { await readFile(path.join(root, "catalog.json")); return await realpath(root); } catch { /* Try the packaged workspace root. */ } }
  throw new Error("Bundled registry was not included in the server deployment.");
}
async function readVerified(entry: { path: string; sha256: string; version: string }, version: string): Promise<string> {
  if (entry.version !== version) throw new Error("Unknown bundled version.");
  const root = await registryRoot();
  if (!/^(bundles|presets)\/[a-z0-9-]+\/SKILL\.md$/.test(entry.path)) throw new Error("Unsafe registry path.");
  const file = await realpath(path.join(root, entry.path));
  if (!file.startsWith(root + path.sep)) throw new Error("Registry path escaped its root.");
  const bytes = await readFile(file);
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("Bundled registry checksum mismatch.");
  return bytes.toString("utf8");
}
export async function resolveBundledSkill(id: string, version: string): Promise<string> {
  const skill = bundledSkills.find(s => s.id === id);
  if (!skill) throw new Error("Unknown bundled skill.");
  return readVerified(skill, version);
}
export async function resolveStarterPreset(id: string, version: string): Promise<string> {
  const preset = starterPresets.find(p => p.id === id);
  if (!preset) throw new Error("Unknown starter preset.");
  return readVerified(preset, version);
}
