import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import {
    getPublishablePackageByDir,
    getSourceExportEntries,
    getWorkspacePackageByName,
    manifestName,
    publishablePackages,
    readPackageManifest,
    releaseStageDir,
    repoRoot,
    sourceExportToDistDtsPath,
    sourceExportToDistJsPath,
} from "./manifest";

type PackageManifest = {
    name: string;
    version?: string;
    private?: boolean;
    publishConfig?: {
        access?: string;
        [key: string]: unknown;
    };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    [key: string]: unknown;
};

type RootManifest = {
    catalog?: Record<string, string>;
};

const rootManifestPath = join(repoRoot, manifestName);

const dependencyFields = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
] as const satisfies ReadonlyArray<keyof PackageManifest>;

function parseCliArgs() {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            version: {
                type: "string",
            },
            "dry-run": {
                type: "boolean",
                default: false,
            },
        },
        strict: true,
        allowPositionals: false,
    });

    const version = values.version?.trim();
    if (!version) {
        throw new Error("Missing required --version argument");
    }

    return {
        version,
        dryRun: values["dry-run"],
    };
}

async function readManifest(packageDir: string): Promise<PackageManifest> {
    const manifestPath = join(repoRoot, packageDir, manifestName);
    const manifest = await readFile(manifestPath, "utf8");
    return JSON.parse(manifest) as PackageManifest;
}

async function readRootCatalog() {
    const manifest = await readFile(rootManifestPath, "utf8");
    const rootManifest = JSON.parse(manifest) as RootManifest;
    return rootManifest.catalog ?? {};
}

function assertPublishableManifest(packageDir: string, manifest: PackageManifest) {
    const releasePackage = getPublishablePackageByDir(packageDir);
    if (!releasePackage) {
        throw new Error(`Package ${packageDir} is not in the publish allowlist`);
    }

    if (manifest.name !== releasePackage.name) {
        throw new Error(
            `Publish allowlist mismatch for ${packageDir}: expected ${releasePackage.name}, found ${manifest.name}`,
        );
    }
}

function rewriteWorkspaceDeps(manifest: PackageManifest, version: string) {
    for (const field of dependencyFields) {
        const deps = manifest[field];
        if (!deps) {
            continue;
        }

        for (const [name, range] of Object.entries(deps)) {
            if (!range.startsWith("workspace:")) {
                continue;
            }

            const workspacePackage = getWorkspacePackageByName(name);
            if (!workspacePackage) {
                throw new Error(`Unknown workspace dependency ${name}`);
            }

            const publishableDependency = getPublishablePackageByDir(workspacePackage.dir);
            if (!publishableDependency) {
                // Internal-only package - must be bundled at build time, so remove from deps
                delete deps[name];
                continue;
            }

            deps[name] = version;
        }
    }
}

function replaceCatalogRanges(deps: Record<string, string> | undefined, catalog: Record<string, string>) {
    if (!deps) {
        return;
    }

    for (const [name, range] of Object.entries(deps)) {
        if (range !== "catalog:") {
            continue;
        }

        const resolved = catalog[name];
        if (!resolved) {
            throw new Error(`Missing catalog entry for ${name}`);
        }

        deps[name] = resolved;
    }
}

function rewriteCatalogDeps(manifest: PackageManifest, catalog: Record<string, string>) {
    for (const field of dependencyFields) {
        replaceCatalogRanges(manifest[field], catalog);
    }
}

function stripDevExportConditions(exports: Record<string, unknown> | undefined) {
    if (!exports) {
        return;
    }

    const devConditions = ["bun", "source"];

    for (const [key, value] of Object.entries(exports)) {
        if (typeof value === "object" && value !== null) {
            for (const condition of devConditions) {
                delete (value as Record<string, unknown>)[condition];
            }
        }
    }
}

function stageManifest(manifest: PackageManifest, version: string, catalog: Record<string, string>): PackageManifest {
    const stagedManifest: PackageManifest = structuredClone(manifest);
    stagedManifest.version = version;
    stagedManifest.private = false;
    stagedManifest.publishConfig = {
        ...stagedManifest.publishConfig,
        access: "public",
    };
    delete stagedManifest.devDependencies;
    delete stagedManifest.source;
    stripDevExportConditions(stagedManifest.exports as Record<string, unknown> | undefined);
    rewriteWorkspaceDeps(stagedManifest, version);
    rewriteCatalogDeps(stagedManifest, catalog);
    return stagedManifest;
}

function shouldCopyPath(sourceDir: string, sourcePath: string) {
    if (sourcePath === sourceDir) {
        return true;
    }

    const relativePath = relative(sourceDir, sourcePath);
    const segments = relativePath.split(sep);

    return !segments.includes("node_modules");
}

async function ensureBuildArtifacts(packageDir: string) {
	const manifest = await readPackageManifest(join(repoRoot, packageDir))
	const sourceExports = getSourceExportEntries(manifest)

	if (sourceExports.length === 0) {
		throw new Error(`No source exports found for ${packageDir}`)
	}

	for (const sourceExport of sourceExports) {
		const jsPath = join(repoRoot, packageDir, sourceExportToDistJsPath(sourceExport))
		const dtsPath = join(repoRoot, packageDir, sourceExportToDistDtsPath(sourceExport))

		if (!(await Bun.file(jsPath).exists())) {
			throw new Error(`Missing built JavaScript artifact: ${jsPath}`)
		}

		if (!(await Bun.file(dtsPath).exists())) {
			throw new Error(`Missing built declaration artifact: ${dtsPath}`)
		}
	}
}

async function preparePackage(packageDir: string, version: string, catalog: Record<string, string>) {
    const sourceDir = join(repoRoot, packageDir);
    const targetDir = join(releaseStageDir, packageDir);
    const sourceManifest = await readManifest(packageDir);

    assertPublishableManifest(packageDir, sourceManifest);
    await ensureBuildArtifacts(packageDir);

    const stagedManifest = stageManifest(sourceManifest, version, catalog);

    await mkdir(join(targetDir, ".."), { recursive: true });
    await cp(sourceDir, targetDir, {
        recursive: true,
        force: true,
        errorOnExist: false,
        filter(sourcePath) {
            return shouldCopyPath(sourceDir, sourcePath);
        },
    });
    await writeFile(join(targetDir, manifestName), `${JSON.stringify(stagedManifest, null, 2)}\n`);

    return {
        packageDir,
        packageName: stagedManifest.name,
        targetDir,
    };
}

async function main() {
    const { version, dryRun } = parseCliArgs();

    await rm(releaseStageDir, { recursive: true, force: true });

    const catalog = await readRootCatalog();
    const preparedPackages = [] as Array<Awaited<ReturnType<typeof preparePackage>>>;
    for (const { dir } of publishablePackages) {
        preparedPackages.push(await preparePackage(dir, version, catalog));
    }

    for (const preparedPackage of preparedPackages) {
        const prefix = dryRun ? "[dry-run] prepared" : "prepared";
        console.log(`${prefix} ${preparedPackage.packageName} in ${preparedPackage.targetDir}`);
    }
}

if (import.meta.main) {
    await main();
}
