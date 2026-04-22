import { type DurableStreamsDevServer, startDurableStreamsDevServer } from '@humanlayer/yjs-fs'

export async function withDurableStreamsDevServer<T>(run: (server: DurableStreamsDevServer) => Promise<T>): Promise<T> {
	const server = await startDurableStreamsDevServer({
		service: `test-${crypto.randomUUID()}`,
	})

	try {
		return await run(server)
	} finally {
		await server.stop()
	}
}
