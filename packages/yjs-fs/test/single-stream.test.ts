import { describe, expect, test } from 'bun:test'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import {
	createInMemorySingleStreamTransport,
	createSingleStreamDurableStreamsClient,
} from '@humanlayer/yjs-fs/durable-streams/single-stream-client'

function createReplica() {
	const doc = new Y.Doc()
	const awareness = new Awareness(doc)
	const filesystem = new YjsFilesystem({ doc, awareness })
	return { doc, awareness, filesystem }
}

describe('single-stream durable transport', () => {
	test('syncs create, edit, and delete operations across two replicas', async () => {
		const transport = createInMemorySingleStreamTransport()
		const client = createSingleStreamDurableStreamsClient({ transport })
		const replicaA = createReplica()
		const replicaB = createReplica()

		const sessionA = await client.connect({ filesystem: replicaA.filesystem })
		const sessionB = await client.connect({ filesystem: replicaB.filesystem })

		replicaA.filesystem.mkdir('/workspace')
		const entryId = replicaA.filesystem.createFile('/workspace/note.txt', 'hello')
		const initialStat = replicaA.filesystem.stat('/workspace/note.txt')

		expect(replicaB.filesystem.exists('/workspace')).toBe(true)
		expect(replicaB.filesystem.readFile('/workspace/note.txt')).toBe('hello')
		expect(replicaB.filesystem.stat('/workspace/note.txt').entryId).toBe(entryId)
		expect(replicaB.filesystem.stat('/workspace/note.txt').contentId).toBe(initialStat.contentId)

		replicaB.filesystem.editFile('/workspace/note.txt', 'hello', 'hello world')
		expect(replicaA.filesystem.readFile('/workspace/note.txt')).toBe('hello world')
		expect(replicaA.filesystem.stat('/workspace/note.txt').contentId).toBe(initialStat.contentId)

		replicaA.filesystem.unlink('/workspace/note.txt')
		expect(replicaB.filesystem.exists('/workspace/note.txt')).toBe(false)

		sessionA.disconnect()
		sessionB.disconnect()
	})

	test('replays filesystem history to a replica that connects later', async () => {
		const transport = createInMemorySingleStreamTransport()
		const client = createSingleStreamDurableStreamsClient({ transport })
		const replicaA = createReplica()
		const sessionA = await client.connect({ filesystem: replicaA.filesystem })

		replicaA.filesystem.mkdir('/workspace')
		replicaA.filesystem.createFile('/workspace/readme.md', 'alpha')
		replicaA.filesystem.editFile('/workspace/readme.md', 'alpha', 'beta')

		const replicaB = createReplica()
		const sessionB = await client.connect({ filesystem: replicaB.filesystem })

		expect(replicaB.filesystem.readFile('/workspace/readme.md')).toBe('beta')
		expect(replicaB.filesystem.list('/workspace').map((entry) => entry.name)).toEqual(['readme.md'])

		sessionA.disconnect()
		sessionB.disconnect()
	})

	test('propagates awareness state over the single-stream topology', async () => {
		const transport = createInMemorySingleStreamTransport()
		const client = createSingleStreamDurableStreamsClient({ transport })
		const replicaA = createReplica()
		const replicaB = createReplica()

		const sessionA = await client.connect({ filesystem: replicaA.filesystem })
		const sessionB = await client.connect({ filesystem: replicaB.filesystem })

		replicaA.filesystem.mkdir('/workspace')
		replicaA.filesystem.createFile('/workspace/note.txt', 'hello world')
		replicaA.filesystem.setLocalPresence({
			user: { id: 'agent-a', name: 'Agent A' },
			activePath: '/workspace/note.txt',
			cursor: { path: '/workspace/note.txt', index: 6, length: 5 },
		})
		replicaA.filesystem.setLocalSelection('/workspace/note.txt', 6, 11)

		const remoteState = Array.from(replicaB.awareness.getStates().values()).find((state) => {
			return state?.presence && typeof state.presence === 'object' && state.presence.user?.id === 'agent-a'
		})

		expect(remoteState).toBeDefined()
		expect(remoteState).toMatchObject({
			presence: {
				user: { id: 'agent-a', name: 'Agent A' },
				activePath: '/workspace/note.txt',
				cursor: { path: '/workspace/note.txt', index: 6, length: 5 },
			},
		})
		expect(remoteState?.selection).toBeDefined()

		sessionA.disconnect()
		sessionB.disconnect()
	})

	test('uses one filesystem channel for root and content bindings plus one awareness channel', async () => {
		const transport = createInMemorySingleStreamTransport()
		const client = createSingleStreamDurableStreamsClient({ transport })
		const replica = createReplica()

		replica.filesystem.mkdir('/workspace')
		replica.filesystem.createFile('/workspace/a.txt', 'A')
		replica.filesystem.createFile('/workspace/b.txt', 'B')

		const session = await client.connect({ filesystem: replica.filesystem })
		const descriptors = session.describeBindings()
		const channelIds = [...new Set(descriptors.map((descriptor) => descriptor.channelId))].sort()

		expect(channelIds).toEqual(['filesystem', 'filesystem.awareness'])
		expect(descriptors.filter((descriptor) => descriptor.kind === 'content')).toHaveLength(2)
		expect(descriptors.every((descriptor) => descriptor.kind !== 'content' || descriptor.channelId === 'filesystem')).toBe(
			true,
		)

		session.disconnect()
	})
})
