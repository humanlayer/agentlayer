#!/usr/bin/env bun

const rootPackage = await Bun.file(new URL('../package.json', import.meta.url)).json()
const expectedVersion = rootPackage.catalog?.zod

if (typeof expectedVersion !== 'string') {
	throw new Error('The root catalog must define an exact Zod version')
}

const errors: string[] = []

for (const workspaceDirectory of ['agents', 'examples', 'packages']) {
	const glob = new Bun.Glob('*/package.json')
	for await (const relativePath of glob.scan({ cwd: new URL(`../${workspaceDirectory}/`, import.meta.url).pathname })) {
		const manifestPath = `${workspaceDirectory}/${relativePath}`
		const manifest = await Bun.file(new URL(`../${manifestPath}`, import.meta.url)).json()

		for (const dependencyType of [
			'dependencies',
			'devDependencies',
			'optionalDependencies',
			'peerDependencies',
		] as const) {
			const declaredVersion = manifest[dependencyType]?.zod
			if (declaredVersion !== undefined && declaredVersion !== 'catalog:') {
				errors.push(`${manifestPath}: ${dependencyType}.zod must use "catalog:", found ${declaredVersion}`)
			}
		}
	}
}

const lockfile = await Bun.file(new URL('../bun.lock', import.meta.url)).text()
const resolvedVersions = new Set([...lockfile.matchAll(/\bzod@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)].map((match) => match[1]))

if (resolvedVersions.size !== 1 || !resolvedVersions.has(expectedVersion)) {
	errors.push(
		`bun.lock must resolve only zod@${expectedVersion}, found: ${[...resolvedVersions].sort().join(', ') || 'none'}`,
	)
}

if (errors.length > 0) {
	throw new Error(`Zod version alignment failed:\n${errors.map((error) => `- ${error}`).join('\n')}`)
}

console.log(`Zod version alignment passed (${expectedVersion})`)
