import type { HeadersRecord } from '@durable-streams/client'
import type { DurableStreamsClient, DurableStreamsClientSession } from './shared'

export type SingleStreamDurableStreamsClientOptions = {
	baseUrl: string
	prefix?: string
	headers?: HeadersRecord
	liveMode?: 'sse' | 'long-poll'
}

export type SingleStreamDurableStreamsFixture = {
	mode: 'single-stream'
	options: SingleStreamDurableStreamsClientOptions
}

export function createSingleStreamDurableStreamsClient(
	options: SingleStreamDurableStreamsClientOptions,
): DurableStreamsClient {
	return {
		mode: 'single-stream',
		async connect() {
			return createSingleStreamFixtureSession(options)
		},
	}
}

export function createSingleStreamDurableStreamsFixture(
	options: SingleStreamDurableStreamsClientOptions,
): SingleStreamDurableStreamsFixture {
	return {
		mode: 'single-stream',
		options,
	}
}

function createSingleStreamFixtureSession(
	options: SingleStreamDurableStreamsClientOptions,
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
