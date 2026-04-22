import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildPackageFromManifest } from '../../scripts/build/package-build.ts'

const MODELS_URL = 'https://models.dev/api.json'

async function refreshModelsJson() {
	const modelsPath = join(import.meta.dir, 'models.json')

	try {
		const response = await fetch(MODELS_URL)
		if (!response.ok) {
			throw new Error(`request failed with status ${response.status}`)
		}

		const data = await response.json()
		if (!data || typeof data !== 'object' || Array.isArray(data)) {
			throw new Error('models API returned an unexpected payload')
		}

		await writeFile(modelsPath, `${JSON.stringify(data, null, 2)}\n`)
		console.log(`Updated ${modelsPath}`)
	} catch (error) {
		console.warn(
			`Unable to refresh models.json, continuing with the existing file: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

await refreshModelsJson()
await buildPackageFromManifest(import.meta.dir)
