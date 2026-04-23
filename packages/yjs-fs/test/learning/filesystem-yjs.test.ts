import { describe, expect, test } from 'bun:test'
import { EntryNotFoundError, YjsFilesystem } from '../../src'
import { waitForDocText, waitForStateVectorSync, waitForSync } from '../util/wait-for'
import { withYjsDurableStreamServer } from './fixture'

describe('Y.js Filesystem Learning Tests', async () => {
	test('Fixture tests', async () => {
		await withYjsDurableStreamServer(async ({ dss, yjss, createProviderWithAwareness }) => {
			const { awareness: awareness1, provider: provider1 } = await createProviderWithAwareness()
			const { awareness: awareness2, provider: provider2 } = await createProviderWithAwareness()

			provider1.doc.getText('test').insert(0, 'abc')
			expect(provider1.doc.getText('test').toJSON()).toEqual('abc')
			await provider1.flush()
			await waitForSync(provider2)
			await waitForDocText(provider2.doc, 'test')
			expect(provider2.doc.getText('test').toJSON()).toEqual('abc')
		})
	})

	describe('Basic Filesystem Operations', async () => {
		await withYjsDurableStreamServer(async ({ dss, yjss, createProviderWithAwareness }) => {
			const { awareness: awareness1, provider: provider1 } = await createProviderWithAwareness()
			const { awareness: awareness2, provider: provider2 } = await createProviderWithAwareness()

			const fs1 = new YjsFilesystem({ doc: provider1.doc, awareness: awareness1 })

			expect(fs1.list('/')).toBeEmpty()

			const exampleFilePath = '/example.md'
			const exampleFileContent = '# This is an example'

			expect(fs1.list('/')).toBeEmpty()
			expect(fs1.createFile(exampleFilePath, exampleFileContent)).toBeString()
			expect(fs1.readFile(exampleFilePath)).toEqual(exampleFileContent)

			// Create the FS
			const fs2 = new YjsFilesystem({ doc: provider2.doc, awareness: awareness2 })

			// technically if this resolves we know the state vectors are the same and so the
			//  fs harness _should_ be the same but worth checking
			await expect(waitForStateVectorSync(fs1.doc, fs2.doc)).resolves.toBeUndefined()

			// ensure it's there
			expect(fs2.list('/').map((e) => e.path)).toContain(exampleFilePath)
			expect(fs2.readFile(exampleFilePath)).toEqual(exampleFileContent)

			// change something on fs2 and let it sync back over
			expect(fs2.unlink(exampleFilePath)).toBeUndefined()
			expect(fs2.exists(exampleFilePath)).toBeFalse()
			expect(() => fs2.readFile(exampleFilePath)).toThrow(EntryNotFoundError)
			await expect(waitForStateVectorSync(fs1.doc, fs2.doc)).resolves.toBeUndefined()
			expect(fs1.list('/')).toBeEmpty()
			expect(fs2.list('/')).toBeEmpty()
		})
	})
})
