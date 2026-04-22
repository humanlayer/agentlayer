import type { HeadersRecord } from '@durable-streams/client'
import type { DurableStreamsClient, DurableStreamsClientSession } from './shared'

export type PerDocumentDurableStreamsClientOptions = {
	baseUrl: string
	prefix?: string
	headers?: HeadersRecord
	liveMode?: 'sse' | 'long-poll'
}

export type PerDocumentDurableStreamsFixture = {
	mode: 'per-document'
	options: PerDocumentDurableStreamsClientOptions
}

export function createPerDocumentDurableStreamsClient(
	options: PerDocumentDurableStreamsClientOptions,
): DurableStreamsClient {
	return {
		mode: 'per-document',
		async connect() {
			return createPerDocumentFixtureSession(options)
		},
	}
}

export function createPerDocumentDurableStreamsFixture(
	options: PerDocumentDurableStreamsClientOptions,
): PerDocumentDurableStreamsFixture {
	return {
		mode: 'per-document',
		options,
	}
}

function createPerDocumentFixtureSession(options: PerDocumentDurableStreamsClientOptions): DurableStreamsClientSession {
	void options
	return {
		mode: 'per-document',
		describeBindings() {
			return []
		},
		async disconnect() {
			return
		},
	}
}
