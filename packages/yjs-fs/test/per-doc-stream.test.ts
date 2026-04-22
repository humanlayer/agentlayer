import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { createPerDocumentDurableStreamsClient } from '@humanlayer/yjs-fs/durable-streams/per-doc-client'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { withDurableStreamsDevServer } from './util/durable-server'
import { waitFor } from './util/wait-for'

function createReplica() {
	const doc = new Y.Doc()
	const awareness = new Awareness(doc)
	const filesystem = new YjsFilesystem({ doc, awareness })
	return { doc, awareness, filesystem }
}

describe('per-document durable transport', () => {
	test('syncs create, edit, and delete operations across two replicas', async () => {
		await withDurableStreamsDevServer(async (server) => {
			const client = createPerDocumentDurableStreamsClient({
				baseUrl: server.yjsBaseUrl,
				prefix: server.service,
			})
			const replicaA = createReplica()
			const replicaB = createReplica()

			const sessionA = await client.connect({ filesystem: replicaA.filesystem })
			const sessionB = await client.connect({ filesystem: replicaB.filesystem })

			replicaA.filesystem.mkdir('/workspace')
			const entryId = replicaA.filesystem.createFile('/workspace/note.txt', 'hello')
			const initialStat = replicaA.filesystem.stat('/workspace/note.txt')

			await waitFor(() => replicaB.filesystem.exists('/workspace/note.txt'))
			expect(replicaB.filesystem.exists('/workspace')).toBe(true)
			expect(replicaB.filesystem.readFile('/workspace/note.txt')).toBe('hello')
			expect(replicaB.filesystem.stat('/workspace/note.txt').entryId).toBe(entryId)
			expect(replicaB.filesystem.stat('/workspace/note.txt').contentId).toBe(initialStat.contentId)

			replicaB.filesystem.editFile('/workspace/note.txt', 'hello', 'hello world')
			await waitFor(() => replicaA.filesystem.readFile('/workspace/note.txt') === 'hello world')
			expect(replicaA.filesystem.stat('/workspace/note.txt').contentId).toBe(initialStat.contentId)

			replicaA.filesystem.unlink('/workspace/note.txt')
			await waitFor(() => !replicaB.filesystem.exists('/workspace/note.txt'))

			await sessionA.disconnect()
			await sessionB.disconnect()
		})
	})

	test('replays root and per-file history to a replica that connects later', async () => {
		await withDurableStreamsDevServer(async (server) => {
			const client = createPerDocumentDurableStreamsClient({
				baseUrl: server.yjsBaseUrl,
				prefix: server.service,
			})
			const replicaA = createReplica()
			const sessionA = await client.connect({ filesystem: replicaA.filesystem })

			replicaA.filesystem.mkdir('/workspace')
			replicaA.filesystem.createFile('/workspace/readme.md', 'alpha')
			replicaA.filesystem.editFile('/workspace/readme.md', 'alpha', 'beta')

			const replicaB = createReplica()
			const sessionB = await client.connect({ filesystem: replicaB.filesystem })

			await waitFor(() => replicaB.filesystem.exists('/workspace/readme.md'))
			expect(replicaB.filesystem.readFile('/workspace/readme.md')).toBe('beta')
			expect(replicaB.filesystem.list('/workspace').map((entry) => entry.name)).toEqual(['readme.md'])

			await sessionA.disconnect()
			await sessionB.disconnect()
		})
	})

	test('propagates awareness state over the per-document topology', async () => {
		await withDurableStreamsDevServer(async (server) => {
			const client = createPerDocumentDurableStreamsClient({
				baseUrl: server.yjsBaseUrl,
				prefix: server.service,
			})
			const replicaA = createReplica()
			const replicaB = createReplica()

			const sessionA = await client.connect({ filesystem: replicaA.filesystem })
			const sessionB = await client.connect({ filesystem: replicaB.filesystem })

			replicaA.filesystem.mkdir('/workspace')
			replicaA.filesystem.createFile('/workspace/note.txt', 'hello world')
			await waitFor(() => replicaB.filesystem.exists('/workspace/note.txt'))
			replicaA.filesystem.setLocalPresence({
				user: { id: 'agent-a', name: 'Agent A' },
				activePath: '/workspace/note.txt',
				cursor: { path: '/workspace/note.txt', index: 6, length: 5 },
			})
			replicaA.filesystem.setLocalSelection('/workspace/note.txt', 6, 11)

			await waitFor(() => {
				return Array.from(replicaB.awareness.getStates().values()).some((state) => {
					return (
						state?.presence && typeof state.presence === 'object' && state.presence.user?.id === 'agent-a'
					)
				})
			})

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

			await sessionA.disconnect()
			await sessionB.disconnect()
		})
	})

	test('uses distinct root, awareness, and per-file channels', async () => {
		await withDurableStreamsDevServer(async (server) => {
			const client = createPerDocumentDurableStreamsClient({
				baseUrl: server.yjsBaseUrl,
				prefix: server.service,
			})
			const replica = createReplica()

			replica.filesystem.mkdir('/workspace')
			replica.filesystem.createFile('/workspace/a.txt', 'A')
			replica.filesystem.createFile('/workspace/b.txt', 'B')

			const session = await client.connect({ filesystem: replica.filesystem })
			const descriptors = session.describeBindings()
			const channelIds = [...new Set(descriptors.map((descriptor) => descriptor.channelId))].sort()

			expect(channelIds).toHaveLength(4)
			expect(channelIds).toContain('_root')
			expect(channelIds).toContain('_awareness')
			expect(descriptors.filter((descriptor) => descriptor.kind === 'content')).toHaveLength(2)
			expect(
				descriptors.every(
					(descriptor) => descriptor.kind !== 'content' || descriptor.channelId.startsWith('_file/'),
				),
			).toBe(true)

			await session.disconnect()
		})
	})
})
