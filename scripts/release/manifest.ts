import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PackageManifest } from './build/package-build'

export type WorkspaceReleaseEntry = {
    name: string;
    dir: string;
};

export const publishablePackages = [
    {
        name: "@humanlayer/agentlayer-core",
        dir: "packages/agentlayer-core",
    },
    {
        name: "@humanlayer/agentlayer-filesystem",
        dir: "packages/agentlayer-filesystem",
    },
    {
        name: "@humanlayer/agentlayer-justbash",
        dir: "packages/agentlayer-justbash",
    },
    {
        name: "@humanlayer/yjs-fs",
        dir: "packages/yjs-fs",
    },
] as const satisfies ReadonlyArray<WorkspaceReleaseEntry>;

export const internalPackages = [
    {
        name: "@humanlayer/agentlayer-docs",
        dir: "packages/docs",
    },
    {
        name: "@humanlayer/docs-agent",
        dir: "agents/docs-agent",
    },
    {
        name: "@humanlayer/yjs-fs-agents",
        dir: "agents/yjs-fs-agents",
    },
] as const satisfies ReadonlyArray<WorkspaceReleaseEntry>;

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const releaseStageDir = join(repoRoot, ".release");
export const manifestName = "package.json";

export type PublishablePackage = (typeof publishablePackages)[number];
export type PublishablePackageName = PublishablePackage["name"];
export type PublishablePackageDir = PublishablePackage["dir"];

const workspacePackages = [...publishablePackages, ...internalPackages] as const;

export function getPublishablePackageByDir(packageDir: string) {
    return publishablePackages.find((pkg) => pkg.dir === packageDir) ?? null;
}

export function getWorkspacePackageByName(packageName: string) {
    return workspacePackages.find((pkg) => pkg.name === packageName) ?? null;
}

export function getStagedPackageDir(packageDir: string) {
    return join(releaseStageDir, packageDir);
}

export async function readPackageManifest(packageDir: string): Promise<PackageManifest> {
	const manifestPath = join(packageDir, manifestName)
	return (await Bun.file(manifestPath).json()) as PackageManifest
}

export function getSourceExportEntries(manifest: PackageManifest): string[] {
	const exportsMap = manifest.exports ?? {}
	return Object.values(exportsMap).filter((value): value is string => typeof value === 'string')
}

export function sourceExportToDistJsPath(sourceExport: string): string {
	if (!sourceExport.startsWith('./src/')) {
		throw new Error(`Expected source export to start with ./src/, got ${sourceExport}`)
	}

	return sourceExport.replace('./src/', './dist/').replace(/\.(ts|tsx)$/, '.js')
}

export function sourceExportToDistDtsPath(sourceExport: string): string {
	if (!sourceExport.startsWith('./src/')) {
		throw new Error(`Expected source export to start with ./src/, got ${sourceExport}`)
	}

	return sourceExport.replace('./src/', './dist/').replace(/\.(ts|tsx)$/, '.d.ts')
}
