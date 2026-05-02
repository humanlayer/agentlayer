import { describe, expect, test } from 'bun:test'
import { DurableStreamTestServer } from '@durable-streams/server'
import { YjsProvider } from '@durable-streams/y-durable-streams'
import { YjsServer } from '@durable-streams/y-durable-streams/server'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import * as decoding from 'lib0/decoding'
import * as Y from 'yjs'
import { createYjsFsWriteTool } from '../src/tools'
import { makeToolContext } from './mocks'

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
	const start = Date.now()
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
		await Bun.sleep(50)
	}
}

async function readPersistedDoc(baseUrl: string, docId: string): Promise<Y.Doc> {
	const response = await fetch(`${baseUrl}/docs/${docId}?offset=-1`)
	if (!response.ok) throw new Error(`Failed to read stream: ${response.status}`)
	const bytes = new Uint8Array(await response.arrayBuffer())
	const doc = new Y.Doc()
	const decoder = decoding.createDecoder(bytes)
	while (decoding.hasContent(decoder)) {
		Y.applyUpdate(doc, decoding.readVarUint8Array(decoder))
	}
	return doc
}

describe('Yjs filesystem tool catalog initialization races', () => {
	test('write tool preserves root metadata after syncing browser-created files', async () => {
		const browserDoc = new Y.Doc()
		const browserFs = new YjsFilesystem({ doc: browserDoc })
		browserFs.createFile('/README.txt', 'hello from browser')

		const agentDoc = new Y.Doc()
		const agentFs = new YjsFilesystem({ doc: agentDoc })
		Y.applyUpdate(agentDoc, Y.encodeStateAsUpdate(browserDoc))

		const writeTool = createYjsFsWriteTool(agentFs)
		await writeTool.execute({ file_path: '/poem.md', content: 'hello from agent' }, makeToolContext())
		Y.applyUpdate(browserDoc, Y.encodeStateAsUpdate(agentDoc))

		expect(browserFs.lookup('/')).toMatchObject({ entryId: 'root' })
		expect(browserFs.readFile('/README.txt')).toBe('hello from browser')
		expect(browserFs.readFile('/poem.md')).toBe('hello from agent')
	})

	test('write tool preserves root metadata through durable streams when filesystem is created after sync', async () => {
		const dsServer = new DurableStreamTestServer({ port: 0 })
		await dsServer.start()
		const yjsServer = new YjsServer({ port: 0, dsServerUrl: dsServer.url })
		await yjsServer.start()

		let browserProvider: YjsProvider | undefined
		let agentProvider: YjsProvider | undefined
		try {
			const docId = crypto.randomUUID()
			const baseUrl = `${yjsServer.url}/v1/yjs/test`

			const browserDoc = new Y.Doc()
			browserProvider = new YjsProvider({
				doc: browserDoc,
				baseUrl,
				docId,
				connect: false,
				liveMode: 'long-poll',
			})
			await browserProvider.connect()
			await waitFor(() => browserProvider?.synced === true, 'browser sync')
			const browserFs = new YjsFilesystem({ doc: browserDoc })
			browserFs.createFile('/README.txt', 'hello from browser')
			await browserProvider.flush()

			const agentDoc = new Y.Doc()
			agentProvider = new YjsProvider({ doc: agentDoc, baseUrl, docId, connect: false, liveMode: 'long-poll' })
			await agentProvider.connect()
			await waitFor(() => agentProvider?.synced === true, 'agent sync')
			const agentFs = new YjsFilesystem({ doc: agentDoc })

			const writeTool = createYjsFsWriteTool(agentFs)
			await writeTool.execute({ file_path: '/poem.md', content: 'hello from agent' }, makeToolContext())
			await agentProvider.flush()

			const persistedDoc = await readPersistedDoc(baseUrl, docId)
			const persistedRoot = persistedDoc.getMap('catalog.entries').get('root') as Y.Map<unknown>
			expect(persistedRoot.toJSON()).toMatchObject({ id: 'root', modifiedAt: expect.any(Number) })
			expect(persistedDoc.getMap('catalog.pathIndex').toJSON()).toMatchObject({ '/poem.md': expect.any(String) })

			await Bun.sleep(500)
			Y.applyUpdate(browserDoc, Y.encodeStateAsUpdate(agentDoc))

			expect(browserFs.lookup('/')).toMatchObject({ entryId: 'root' })
			expect(browserFs.readFile('/README.txt')).toBe('hello from browser')
			expect(browserFs.readFile('/poem.md')).toBe('hello from agent')
		} finally {
			browserProvider?.destroy()
			agentProvider?.destroy()
			dsServer.stop().catch(() => {})
		}
	}, 15_000)
})
