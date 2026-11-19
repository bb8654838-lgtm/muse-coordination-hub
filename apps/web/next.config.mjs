import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.resolve(appDirectory, "../.."),
  outputFileTracingIncludes: {
    "/api/owner/**": [
      "../../packages/skills/catalog.json",
      "../../packages/skills/bundles/**/*",
      "../../packages/skills/presets/**/*",
    ],
  },
};

export default nextConfig;
