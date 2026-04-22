import process from "node:process";
import { parseArgs } from "node:util";

import { publishablePackages } from "./manifest";

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

const { version, dryRun } = parseCliArgs();

for (const packageDir of publishablePackages) {
    if (dryRun) {
        console.log(`[dry-run] would publish ${packageDir} at ${version}`);
        continue;
    }

    console.log(`publish flow for ${packageDir} at ${version} is not implemented yet`);
}

if (!dryRun) {
    process.exitCode = 1;
}
