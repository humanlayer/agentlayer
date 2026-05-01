import process from 'node:process'

function getVersionFromRef(ref: string): string {
	const prefix = 'refs/tags/v'
	if (!ref.startsWith(prefix)) {
		throw new Error(`Expected a v* tag ref, got ${ref}`)
	}

	const version = ref.slice(prefix.length).trim()
	if (!version) {
		throw new Error(`Could not derive version from ${ref}`)
	}

	return version
}

function getDistTag(version: string): string {
	const prerelease = version.split('-')[1]
	if (!prerelease) return 'latest'
	return prerelease.split('.')[0] || 'next'
}

function appendGithubOutput(values: Record<string, string>) {
	const outputPath = process.env.GITHUB_OUTPUT
	if (!outputPath) {
		for (const [key, value] of Object.entries(values)) {
			console.log(`${key}=${value}`)
		}
		return
	}

	const body = Object.entries(values)
		.map(([key, value]) => `${key}=${value}`)
		.join('\n')
	Bun.write(outputPath, `${body}\n`, { createPath: true })
}

const version = getVersionFromRef(process.env.GITHUB_REF ?? '')
appendGithubOutput({ version, tag: getDistTag(version) })
