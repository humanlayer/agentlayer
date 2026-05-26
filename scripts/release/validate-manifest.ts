import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
	getWorkspacePackageByName,
	getPublishablePackageByDir,
	publishablePackages,
	repoRoot,
} from './manifest'

const dependencyFields = ['dependencies', 'peerDependencies'] as const

async function main() {
	let errors = 0

	for (const pkg of publishablePackages) {
		const manifestPath = join(repoRoot, pkg.dir, 'package.json')
		const manifest = await Bun.file(manifestPath).json()

		for (const field of dependencyFields) {
			const deps = manifest[field]
			if (!deps) continue

			for (const [name, range] of Object.entries(deps) as [string, string][]) {
				if (!range.startsWith('workspace:')) continue

				const workspacePackage = getWorkspacePackageByName(name)
				if (!workspacePackage) {
					console.error(`${pkg.name}: unknown workspace dependency ${name} in ${field}`)
					errors++
					continue
				}

				const publishable = getPublishablePackageByDir(workspacePackage.dir)
				if (!publishable) {
					console.error(
						`${pkg.name}: dependency ${name} in ${field} is internal-only (not publishable). Move it to devDependencies if it's bundled at build time.`,
					)
					errors++
				}
			}
		}
	}

	if (errors > 0) {
		console.error(`\n${errors} release manifest error(s) found`)
		process.exit(1)
	}

	console.log('release manifest validation passed')
}

await main()
