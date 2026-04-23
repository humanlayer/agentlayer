import { DurableStreamTestServer } from '@durable-streams/server'
import { YjsProvider, type YjsProviderOptions } from '@durable-streams/y-durable-streams'
import { YjsServer } from '@durable-streams/y-durable-streams/server'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { YjsFilesystem } from '../../src'
import { waitForSync } from '../util/wait-for'

/**
 * Fixture for setting up  4 durable streams filesystems
 * @param count
 * @param run
 */
export async function withYjsDurableStreamFileSystems(
	run: (filesystems: [YjsFilesystem, YjsFilesystem, YjsFilesystem, YjsFilesystem]) => Promise<undefined>,
) {
	await withYjsDurableStreamServer(async ({ dss, yjss, createProviderWithAwareness }) => {
		const createFilesystem = async () => {
			const { provider, awareness } = await createProviderWithAwareness()
			return new YjsFilesystem({ doc: provider.doc, awareness })
		}
		const filesystems: [YjsFilesystem, YjsFilesystem, YjsFilesystem, YjsFilesystem] = await Promise.all([
			createFilesystem(),
			createFilesystem(),
			createFilesystem(),
			createFilesystem(),
		] as const)

		await run(filesystems)
	})
}

/**
 * Fixture for setting up a durable stream server, Y.js server, and factory for provider+awareness on top of those
 * @param run
 */
export async function withYjsDurableStreamServer(
	run: (options: {
		dss: DurableStreamTestServer
		yjss: YjsServer
		createProviderWithAwareness: (
			options?: Parameters<typeof createProviderWithAwareness>[1],
		) => ReturnType<typeof createProviderWithAwareness>
	}) => Promise<void>,
) {
	const dss: DurableStreamTestServer = new DurableStreamTestServer({ port: 0 })
	await dss.start()
	const yjss: YjsServer = new YjsServer({ port: 0, dsServerUrl: dss.url })
	await yjss.start()
	await run({
		dss,
		yjss,
		createProviderWithAwareness: async (options) => createProviderWithAwareness(yjss, options),
	})
}

/**
 * Factory function that given a Y.js Server creates a new provider and awareness
 * @param yjss
 * @param options
 * @returns
 */
const createProviderWithAwareness = async (
	yjss: YjsServer,
	options?: Partial<Pick<YjsProviderOptions, 'doc' | 'liveMode' | 'docId' | 'awareness'>> & {
		serviceName?: string
	},
) => {
	const {
		doc = new Y.Doc(),
		liveMode = 'long-poll',
		docId = 'document',
		awareness = new Awareness(doc),
		serviceName = 'test-service-name',
	} = options ?? {}

	const provider = new YjsProvider({
		doc,
		docId,
		liveMode,
		connect: false,
		baseUrl: `${yjss.url}/v1/yjs/${serviceName}`,
		awareness,
	})
	await provider.connect()
	await waitForSync(provider)

	return {
		provider,
		awareness,
	}
}
