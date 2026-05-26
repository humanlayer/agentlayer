import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getSourceExportEntries, readPackageManifest } from '../../scripts/build/package-build.ts'

const packageDir = import.meta.dir
const manifest = await readPackageManifest(packageDir)
const entrypoints = getSourceExportEntries(manifest)

if (entrypoints.length === 0) {
	throw new Error(`No exports found in ${manifest.name}`)
}

const outdir = resolve(packageDir, 'dist')
await rm(outdir, { recursive: true, force: true })

const result = await Bun.build({
	entrypoints: entrypoints.map((e) => resolve(packageDir, e)),
	outdir,
	root: resolve(packageDir, 'src'),
	format: 'esm',
	target: 'node',
	sourcemap: 'external',
	splitting: false,
	naming: '[dir]/[name].[ext]',
	// Don't use packages: 'external' - instead explicitly list externals
	// This bundles @humanlayer/opencode-llm-vendor inline
	external: ['@ai-sdk/*', '@humanlayer/agentlayer-core', '@humanlayer/agentlayer-provider-auth', 'ai', 'effect'],
})

if (!result.success) {
	throw new AggregateError(result.logs, `Build failed for ${manifest.name}`)
}

if (result.logs.length > 0) {
	for (const log of result.logs) {
		console.warn(log)
	}
}
