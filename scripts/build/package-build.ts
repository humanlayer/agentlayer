import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export interface PackageManifest {
	name: string
	version?: string
	exports?: Record<string, string | Record<string, string>>
	publishConfig?: Record<string, unknown>
}

export async function readPackageManifest(packageDir: string): Promise<PackageManifest> {
	const manifestPath = join(packageDir, 'package.json')
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

export async function buildPackageFromManifest(packageDir: string): Promise<void> {
	const manifest = await readPackageManifest(packageDir)
	const entrypoints = getSourceExportEntries(manifest)

	if (entrypoints.length === 0) {
		throw new Error(`No string exports found in ${manifest.name}`)
	}

	const outdir = resolve(packageDir, 'dist')
	await rm(outdir, { recursive: true, force: true })

	const result = await Bun.build({
		entrypoints: entrypoints.map((entrypoint) => resolve(packageDir, entrypoint)),
		outdir,
		root: resolve(packageDir, 'src'),
		format: 'esm',
		target: 'node',
		packages: 'external',
		sourcemap: 'external',
		splitting: false,
		naming: '[dir]/[name].[ext]',
	})

	if (!result.success) {
		throw new AggregateError(result.logs, `Build failed for ${manifest.name}`)
	}

	if (result.logs.length > 0) {
		for (const log of result.logs) {
			console.warn(log)
		}
	}
}
