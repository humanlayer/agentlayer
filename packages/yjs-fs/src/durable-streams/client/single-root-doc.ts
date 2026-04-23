import type { HeadersRecord } from '@durable-streams/client'
import type { DurableStreamsClient, DurableStreamsClientSession } from '../shared/types'

export type SingleRootDocDurableStreamsClientOptions = {
	baseUrl: string
	prefix?: string
	headers?: HeadersRecord
	liveMode?: 'sse' | 'long-poll'
}

export type SingleRootDocDurableStreamsFixture = {
	mode: 'single-stream'
	options: SingleRootDocDurableStreamsClientOptions
}

export function createSingleStreamDurableStreamsClient(
	options: SingleRootDocDurableStreamsClientOptions,
): DurableStreamsClient {
	return {
		mode: 'single-stream',
		async connect() {
			return createSingleStreamFixtureSession(options)
		},
	}
}

export function createSingleStreamDurableStreamsFixture(
	options: SingleRootDocDurableStreamsClientOptions,
): SingleRootDocDurableStreamsFixture {
	return {
		mode: 'single-stream',
		options,
	}
}

function createSingleStreamFixtureSession(
	options: SingleRootDocDurableStreamsClientOptions,
): DurableStreamsClientSession {
	void options
	return {
		mode: 'single-stream',
		describeBindings() {
			return []
		},
		async disconnect() {
			return
		},
	}
}
