import { spawn } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { getStagedPackageDir, manifestName, publishablePackages, releaseStageDir } from "./manifest";

type PackageManifest = {
    name: string;
    version?: string;
};

type RunCommandOptions = {
    cwd?: string;
    allowFailure?: boolean;
    stdio?: "pipe" | "inherit";
};

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

async function runCommand(command: string, args: string[], options: RunCommandOptions = {}) {
    const { cwd, allowFailure = false, stdio = "pipe" } = options;

    return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
            env: process.env,
        });

        let stdout = "";
        let stderr = "";

        if (stdio === "pipe") {
            child.stdout?.on("data", (chunk) => {
                stdout += chunk.toString();
            });
            child.stderr?.on("data", (chunk) => {
                stderr += chunk.toString();
            });
        }

        child.on("error", (error) => {
            reject(error);
        });

        child.on("close", (code) => {
            const exitCode = code ?? 1;
            if (exitCode !== 0 && !allowFailure) {
                reject(new Error(`Command failed: ${command} ${args.join(" ")}`));
                return;
            }

            resolve({ exitCode, stdout, stderr });
        });
    });
}

async function readManifest(packageDir: string): Promise<PackageManifest> {
    const manifestPath = join(packageDir, manifestName);
    const manifest = await readFile(manifestPath, "utf8");
    return JSON.parse(manifest) as PackageManifest;
}

async function ensureReleaseStageExists() {
    try {
        await access(releaseStageDir);
    } catch {
        throw new Error(`Missing release stage at ${releaseStageDir}. Run bun run release:prepare first.`);
    }
}

async function ensureOnlyAllowlistedPackagesAreStaged() {
    const stagedEntries = await readdir(releaseStageDir, { recursive: true, withFileTypes: true });
    const stagedPackageDirs = new Set<string>();

    for (const entry of stagedEntries) {
        if (!entry.isFile() || entry.name !== manifestName || !entry.parentPath) {
            continue;
        }

        const relativeDir = entry.parentPath.slice(releaseStageDir.length + 1).replaceAll("\\", "/");
        if (!relativeDir.startsWith('packages/') && !relativeDir.startsWith('agents/')) {
            continue;
        }

        const packageDir = relativeDir.split('/').slice(0, 2).join('/');
        stagedPackageDirs.add(packageDir);
    }

    const expectedDirs = new Set(publishablePackages.map((pkg) => pkg.dir));

    for (const stagedDir of stagedPackageDirs) {
        if (!expectedDirs.has(stagedDir)) {
            throw new Error(`Unexpected staged package found at ${stagedDir}`);
        }
    }

    for (const expectedDir of expectedDirs) {
        if (!stagedPackageDirs.has(expectedDir)) {
            throw new Error(`Expected staged package missing at ${expectedDir}`);
        }
    }
}

async function ensureVersionDoesNotAlreadyExist(packageName: string, version: string) {
    const result = await runCommand("bun", ["pm", "view", packageName, "versions", "--json"], {
        allowFailure: true,
    });

    if (result.exitCode !== 0 || !result.stdout.trim()) {
        return;
    }

    const parsed = JSON.parse(result.stdout) as string[];
    if (parsed.includes(version)) {
        throw new Error(`Version ${version} already exists for ${packageName}`);
    }
}

async function packageForDryRun(packageDir: string) {
    await runCommand("bun", ["pm", "pack", "--dry-run"], {
        cwd: packageDir,
        stdio: "inherit",
    });
}

async function bunPublish(packageDir: string) {
	await runCommand("bun", ["publish", "--access", "public"], {
		cwd: packageDir,
		stdio: "inherit",
	});
}

async function main() {
    const { version, dryRun } = parseCliArgs();

    await ensureReleaseStageExists();
    await ensureOnlyAllowlistedPackagesAreStaged();

    for (const pkg of publishablePackages) {
        const stagedPackageDir = getStagedPackageDir(pkg.dir);
        const manifest = await readManifest(stagedPackageDir);

        if (manifest.name !== pkg.name) {
            throw new Error(`Staged manifest mismatch for ${pkg.dir}: expected ${pkg.name}, found ${manifest.name}`);
        }

        if (manifest.version !== version) {
            throw new Error(`Staged manifest mismatch for ${pkg.name}: expected version ${version}, found ${manifest.version}`);
        }

        await ensureVersionDoesNotAlreadyExist(manifest.name, version);

        if (dryRun) {
            console.log(`[dry-run] packaging ${manifest.name} from ${stagedPackageDir}`);
            await packageForDryRun(stagedPackageDir);
            continue;
        }

        console.log(`publishing ${manifest.name} from ${stagedPackageDir}`);
        await bunPublish(stagedPackageDir);
    }
}

if (import.meta.main) {
    await main();
}
