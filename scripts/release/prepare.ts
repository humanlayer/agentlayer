import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { manifestName, publishablePackages, releaseStageDir, repoRoot } from "./manifest";

type PackageManifest = {
    name: string;
    version?: string;
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

function rewriteWorkspaceDeps(manifest: PackageManifest, version: string) {
    for (const field of dependencyFields) {
        const deps = manifest[field];
        if (!deps) {
            continue;
        }

        for (const [name, range] of Object.entries(deps)) {
            if (range === "workspace:*" || range.startsWith("workspace:")) {
                deps[name] = version;
            }
        }
    }
}

function stageManifest(manifest: PackageManifest, version: string): PackageManifest {
    const stagedManifest: PackageManifest = structuredClone(manifest);
    stagedManifest.version = version;
    stagedManifest.publishConfig = {
        ...stagedManifest.publishConfig,
        access: "public",
    };
    rewriteWorkspaceDeps(stagedManifest, version);
    return stagedManifest;
}

async function preparePackage(packageDir: string, version: string) {
    const sourceDir = join(repoRoot, packageDir);
    const targetDir = join(releaseStageDir, packageDir);
    const sourceManifest = await readManifest(packageDir);
    const stagedManifest = stageManifest(sourceManifest, version);

    await mkdir(join(targetDir, ".."), { recursive: true });
    await cp(sourceDir, targetDir, {
        recursive: true,
        force: true,
        errorOnExist: false,
        filter(source) {
            return !source.includes(`${packageDir}/node_modules`) && !source.includes(`${packageDir}/dist`);
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

    const preparedPackages = [] as Array<Awaited<ReturnType<typeof preparePackage>>>;
    for (const packageDir of publishablePackages) {
        preparedPackages.push(await preparePackage(packageDir, version));
    }

    if (dryRun) {
        for (const preparedPackage of preparedPackages) {
            console.log(`[dry-run] prepared ${preparedPackage.packageName} in ${preparedPackage.targetDir}`);
        }
        await rm(releaseStageDir, { recursive: true, force: true });
        return;
    }

    for (const preparedPackage of preparedPackages) {
        console.log(`prepared ${preparedPackage.packageName} in ${preparedPackage.targetDir}`);
    }
}

await main();
