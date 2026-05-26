import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getSourceExportEntries, readPackageManifest } from '../../scripts/build/package-build.ts'

const packageDir = import.meta.dir
const manifest = await readPackageManifest(packageDir)
const entrypoints = getSourceExportEntries(manifest)

const outdir = resolve(packageDir, 'dist')
await rm(outdir, { recursive: true, force: true })

const m = manifest as unknown as Record<string, Record<string, string> | undefined>
const deps = Object.keys(m.dependencies ?? {})
const peerDeps = Object.keys(m.peerDependencies ?? {})

const result = await Bun.build({
	entrypoints: entrypoints.map((ep) => resolve(packageDir, ep)),
	outdir,
	root: resolve(packageDir, 'src'),
	format: 'esm',
	target: 'node',
	external: [...deps, ...peerDeps],
	sourcemap: 'external',
	splitting: false,
	naming: '[dir]/[name].[ext]',
})

if (!result.success) {
	throw new AggregateError(result.logs, `Build failed for ${manifest.name}`)
}
