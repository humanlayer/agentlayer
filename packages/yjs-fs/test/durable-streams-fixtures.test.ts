import { describe, expect, test } from 'bun:test'
import { createPerDocumentDurableStreamsClient } from '@humanlayer/yjs-fs/durable-streams/per-doc-client'
import { createSingleStreamDurableStreamsClient } from '@humanlayer/yjs-fs/durable-streams/single-stream-client'
import { withDurableStreamsDevServer } from './util/durable-server'

describe('durable streams fixtures', () => {
	test('starts a local durable streams dev server fixture', async () => {
		await withDurableStreamsDevServer(async (server) => {
			expect(server.service).toBeTruthy()
			expect(server.durableStreamsBaseUrl.startsWith('http://')).toBe(true)
			expect(server.yjsBaseUrl.startsWith('http://')).toBe(true)
			expect(server.streamUrl('/v1/stream/test')).toContain('/v1/stream/test')
			expect(server.docUrl('root')).toContain(`/v1/yjs/${server.service}/docs/root`)
		})
	})

	test('creates a per-document durable streams client fixture', () => {
		const client = createPerDocumentDurableStreamsClient({
			baseUrl: 'http://127.0.0.1:1234',
			prefix: 'fixture',
		})

		expect(client.mode).toBe('per-document')
	})

	test('creates a single-stream durable streams client fixture', () => {
		const client = createSingleStreamDurableStreamsClient({
			baseUrl: 'http://127.0.0.1:1234',
			prefix: 'fixture',
		})

		expect(client.mode).toBe('single-stream')
	})
})
