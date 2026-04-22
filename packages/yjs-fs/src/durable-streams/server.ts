import { DurableStreamTestServer } from '@durable-streams/server'
import { YjsServer } from '@durable-streams/y-durable-streams/server'
import type { DurableStreamsServerOptions } from '../surface'

export type { DurableStreamsServerOptions }

export type DurableStreamsDevServer = {
	readonly options: DurableStreamsServerOptions
	readonly durableStreamsBaseUrl: string
	readonly yjsBaseUrl: string
	readonly service: string
	streamUrl(path: string): string
	docUrl(docId: string): string
	stop(): Promise<void>
}

export async function startDurableStreamsDevServer(
	options: DurableStreamsServerOptions = {},
): Promise<DurableStreamsDevServer> {
	const service = options.service ?? 'yjs-fs'
	const durableServer = new DurableStreamTestServer({
		host: options.host,
		port: options.durableStreamsPort ?? 0,
		dataDir: options.dataDir,
	})
	const durableStreamsBaseUrl = await durableServer.start()

	const yjsServer = new YjsServer({
		host: options.host,
		port: options.yjsPort ?? 0,
		dsServerUrl: durableStreamsBaseUrl,
	})
	const yjsBaseUrl = await yjsServer.start()

	return {
		options,
		durableStreamsBaseUrl,
		yjsBaseUrl,
		service,
		streamUrl(path: string) {
			return `${durableStreamsBaseUrl}${normalizeStreamPath(path)}`
		},
		docUrl(docId: string) {
			return `${yjsBaseUrl}/v1/yjs/${service}/docs/${normalizeDocId(docId)}`
		},
		async stop() {
			await yjsServer.stop()
			await durableServer.stop()
		},
	}
}

export function defineDurableStreamsServer(options: DurableStreamsServerOptions = {}) {
	return {
		options,
		start() {
			return startDurableStreamsDevServer(options)
		},
	}
}

function normalizeStreamPath(path: string): string {
	if (path.startsWith('/')) {
		return path
	}

	return `/${path}`
}

function normalizeDocId(docId: string): string {
	return docId
		.split('/')
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0)
		.join('/')
}
