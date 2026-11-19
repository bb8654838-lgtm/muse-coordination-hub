/** Metadata-only browser entry point; content resolution is intentionally separate. */
import catalogData from "../catalog.json";
export type BundledSkill = (typeof catalogData.skills)[number];
export type StarterPreset = (typeof catalogData.presets)[number];
export const catalog = catalogData;
export const bundledSkills: readonly BundledSkill[] = catalogData.skills;
export const starterPresets: readonly StarterPreset[] = catalogData.presets;
export const getBundledSkill = (id: string) => bundledSkills.find(skill => skill.id === id);
export const getStarterPreset = (id: string) => starterPresets.find(preset => preset.id === id);
