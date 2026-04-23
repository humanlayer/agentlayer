import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { YjsFilesystem } from '../../src'
import { waitForStateVectorSync } from '../util/wait-for'
import { withYjsDurableStreamServer } from './fixture'

const execFileAsync = promisify(execFile)

describe('Y.js Filesystem Binary Learning Tests', () => {
	test('syncs a PNG across replicas and preserves its sha256 on disk', async () => {
		await withYjsDurableStreamServer(async ({ createProviderWithAwareness }) => {
			const { awareness: awareness1, provider: provider1 } = await createProviderWithAwareness()
			const { awareness: awareness2, provider: provider2 } = await createProviderWithAwareness()
			const fs1 = new YjsFilesystem({ doc: provider1.doc, awareness: awareness1 })
			const fs2 = new YjsFilesystem({ doc: provider2.doc, awareness: awareness2 })

			const sourcePath = fileURLToPath(new URL('./sample.png', import.meta.url))
			const sourceBytes = new Uint8Array(await Bun.file(sourcePath).arrayBuffer())
			const tempDir = await mkdtemp(join(tmpdir(), 'yjs-fs-binary-'))

			try {
				fs1.mkdir('/assets')
				fs1.createBinaryFile('/assets/sample.png', sourceBytes)
				await provider1.flush()
				await waitForStateVectorSync(fs1.doc, fs2.doc)

				const replicatedBytes = fs2.readBinaryFile('/assets/sample.png')
				const restoredPath = join(tempDir, 'sample-roundtrip.png')
				await Bun.write(restoredPath, replicatedBytes)

				expect(fs2.stat('/assets/sample.png').encoding).toBe('binary')
				expect(replicatedBytes).toEqual(sourceBytes)
				expect(await shasumFile(sourcePath)).toBe(await shasumFile(restoredPath))
			} finally {
				await rm(tempDir, { recursive: true, force: true })
			}
		})
	})
})

async function shasumFile(path: string): Promise<string> {
	const { stdout } = await execFileAsync('shasum', ['-a', '256', path])
	const hash = stdout.trim().split(/\s+/)[0]

	if (!hash) {
		throw new Error(`Missing shasum output for ${path}`)
	}

	return hash
}
