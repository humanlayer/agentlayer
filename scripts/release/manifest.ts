import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const publishablePackages = [
    "packages/agentlayer-core",
    "packages/agentlayer-filesystem",
    "packages/agentlayer-justbash",
    "packages/yjs-fs",
] as const;

export const internalPackages = [
    "packages/docs",
    "agents/yjs-fs-agents",
    "agents/docs-agent",
] as const;

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const releaseStageDir = join(repoRoot, ".release");
export const manifestName = "package.json";

export type PublishablePackageDir = (typeof publishablePackages)[number];
