import { DurableStreamTestServer } from '@durable-streams/server'
import { YjsServer } from '@durable-streams/y-durable-streams/server'

const DS_PORT = 4437
const YJS_PORT = 4438

async function main() {
	console.log('Starting Durable Streams server...')
	const dsServer = new DurableStreamTestServer({
		port: DS_PORT,
		host: '127.0.0.1',
	})
	await dsServer.start()
	console.log(`Durable Streams server running at http://127.0.0.1:${DS_PORT}`)

	console.log('Starting Y.js server...')
	const yjsServer = new YjsServer({
		port: YJS_PORT,
		host: '127.0.0.1',
		dsServerUrl: `http://127.0.0.1:${DS_PORT}`,
		compactionThreshold: 1024 * 1024,
	})
	const yjsUrl = await yjsServer.start()
	console.log(`Y.js server running at ${yjsUrl}`)

	console.log('\nServers ready. Press Ctrl+C to stop.')

	process.on('SIGINT', async () => {
		console.log('\nShutting down...')
		process.exit(0)
	})
}

main().catch((err) => {
	console.error('Failed to start servers:', err)
	process.exit(1)
})
