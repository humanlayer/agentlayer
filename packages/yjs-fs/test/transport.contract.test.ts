import { describe, expect, test } from 'bun:test'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
	EntryNotFoundError,
	resolveLocalSelectionState,
	YjsFilesystem,
} from '@humanlayer/yjs-fs'
import {
	createPerDocumentDurableStreamsClient,
} from '@humanlayer/yjs-fs/durable-streams/per-doc-client'
import {
	createInMemorySingleStreamTransport,
	createSingleStreamDurableStreamsClient,
} from '@humanlayer/yjs-fs/durable-streams/single-stream-client'
import {
	sortBindingDescriptors,
	type DurableStreamsBindingDescriptor,
	type DurableStreamsClient,
	type DurableStreamsClientSession,
	type DurableStreamsTransportMode,
} from '@humanlayer/yjs-fs/durable-streams/shared'
import { snapshotFilesystem } from './support/snapshot'

type TransportHarness = {
	mode: DurableStreamsTransportMode
	createClient(): DurableStreamsClient
}

type Replica = {
	filesystem: YjsFilesystem
	awareness: Awareness | null
	doc: Y.Doc
}

type BindingFixture = {
	filesystem: YjsFilesystem
	contentIds: string[]
}

const transportHarnesses: TransportHarness[] = [
	{
		mode: 'single-stream',
		createClient() {
			return createSingleStreamDurableStreamsClient({
				transport: createInMemorySingleStreamTransport(),
			})
		},
	},
	{
		mode: 'per-document',
		createClient() {
			return createPerDocumentDurableStreamsClient({
				baseUrl: 'http://127.0.0.1:1',
				prefix: 'contract-placeholder',
			})
		},
	},
]

describe('durable streams transport contract', () => {
	for (const harness of transportHarnesses) {
		describe(harness.mode, () => {
			runTransportContractSuite(harness)
		})
	}
})

function runTransportContractSuite(harness: TransportHarness): void {
	test('describes root, awareness, and content bindings for the filesystem', async () => {
		const fixture = createBindingFixture()
		const client = harness.createClient()
		const session = await client.connect({ filesystem: fixture.filesystem })

		expect(session.mode).toBe(harness.mode)
		expect(client.mode).toBe(harness.mode)
		expect(sortBindingDescriptors(session.describeBindings())).toEqual(
			expectedBindings(harness.mode, fixture.contentIds, true),
		)

		await disconnectSessions(session)
	})

	test('tracks content binding additions and removals without changing filesystem API shape', async () => {
		const fixture = createBindingFixture()
		const baselineMethods = filesystemMethodNames(fixture.filesystem)
		const session = await harness.createClient().connect({ filesystem: fixture.filesystem })

		fixture.filesystem.createFile('/workspace/gamma.txt', 'gamma')
		const gammaContentId = fixture.filesystem.stat('/workspace/gamma.txt').contentId
		if (!gammaContentId) {
			throw new Error('expected gamma.txt contentId')
		}

		expect(sortBindingDescriptors(session.describeBindings())).toEqual(
			expectedBindings(harness.mode, [...fixture.contentIds, gammaContentId], true),
		)

		fixture.filesystem.unlink('/workspace/beta.txt')
		const [alphaContentId] = fixture.contentIds
		if (!alphaContentId) {
			throw new Error('expected alpha.txt contentId')
		}

		expect(sortBindingDescriptors(session.describeBindings())).toEqual(
			expectedBindings(harness.mode, [alphaContentId, gammaContentId], true),
		)
		expect(filesystemMethodNames(fixture.filesystem)).toEqual(baselineMethods)

		await disconnectSessions(session)
	})

	test('adds awareness binding only when awareness is configured', async () => {
		const withoutAwareness = createBindingFixture({ awareness: false })
		const session = await harness.createClient().connect({ filesystem: withoutAwareness.filesystem })

		expect(sortBindingDescriptors(session.describeBindings())).toEqual(
			expectedBindings(harness.mode, withoutAwareness.contentIds, false),
		)

		await disconnectSessions(session)
	})

	test('clears described bindings on disconnect', async () => {
		const fixture = createBindingFixture()
		const session = await harness.createClient().connect({ filesystem: fixture.filesystem })

		expect(session.describeBindings().length).toBeGreaterThan(0)
		await disconnectSessions(session)
		expect(session.describeBindings()).toEqual([])
	})

	test('propagates create, edit, rename, and delete operations across replicas', async () => {
		const { replicaA, replicaB, sessionA, sessionB } = await connectReplicas(harness)

		replicaA.filesystem.mkdir('/workspace')
		const entryId = replicaA.filesystem.createFile('/workspace/note.txt', 'hello')
		const initialStat = replicaA.filesystem.stat('/workspace/note.txt')
		const initialBindings = sortBindingDescriptors(sessionA.describeBindings())

		expect(replicaB.filesystem.readFile('/workspace/note.txt')).toBe('hello')
		expect(replicaB.filesystem.stat('/workspace/note.txt').entryId).toBe(entryId)
		expect(replicaB.filesystem.stat('/workspace/note.txt').contentId).toBe(initialStat.contentId)

		replicaB.filesystem.editFile('/workspace/note.txt', 'hello', 'hello world')
		expect(replicaA.filesystem.readFile('/workspace/note.txt')).toBe('hello world')
		expect(replicaA.filesystem.stat('/workspace/note.txt').contentId).toBe(initialStat.contentId)

		replicaA.filesystem.rename('/workspace/note.txt', '/workspace/renamed.txt')
		expect(replicaA.filesystem.exists('/workspace/note.txt')).toBe(false)
		expect(replicaB.filesystem.exists('/workspace/note.txt')).toBe(false)
		expect(replicaB.filesystem.readFile('/workspace/renamed.txt')).toBe('hello world')
		expect(replicaB.filesystem.stat('/workspace/renamed.txt').entryId).toBe(entryId)
		expect(replicaB.filesystem.stat('/workspace/renamed.txt').contentId).toBe(initialStat.contentId)
		expect(sortBindingDescriptors(sessionA.describeBindings())).toEqual(initialBindings)
		expect(sortBindingDescriptors(sessionB.describeBindings())).toEqual(initialBindings)

		replicaB.filesystem.editFile('/workspace/renamed.txt', 'world', 'transport')
		expect(replicaA.filesystem.readFile('/workspace/renamed.txt')).toBe('hello transport')

		replicaA.filesystem.unlink('/workspace/renamed.txt')
		expect(replicaA.filesystem.exists('/workspace/renamed.txt')).toBe(false)
		expect(replicaB.filesystem.exists('/workspace/renamed.txt')).toBe(false)
		expect(sortBindingDescriptors(sessionA.describeBindings())).toEqual(
			expectedBindings(harness.mode, [], true),
		)
		expect(sortBindingDescriptors(sessionB.describeBindings())).toEqual(
			expectedBindings(harness.mode, [], true),
		)

		await disconnectSessions(sessionA, sessionB)
	})

	test('propagates comments across replicas and preserves them through rename', async () => {
		const { replicaA, replicaB, sessionA, sessionB } = await connectReplicas(harness)

		replicaA.filesystem.mkdir('/workspace')
		replicaA.filesystem.createFile('/workspace/note.txt', 'hello world')
		const commentId = replicaA.filesystem.addComment(
			'/workspace/note.txt',
			{ index: 6, length: 5 },
			'Review world',
			'alice',
		)

		expect(replicaB.filesystem.getComments('/workspace/note.txt')).toEqual(
			replicaA.filesystem.getComments('/workspace/note.txt'),
		)

		replicaB.filesystem.editFile('/workspace/note.txt', 'hello', 'hello there')
		const commentsAfterEdit = replicaA.filesystem.getComments('/workspace/note.txt')
		expect(commentsAfterEdit).toHaveLength(1)
		expect(commentsAfterEdit[0]).toMatchObject({
			id: commentId,
			anchorLength: 5,
		})
		expect(commentsAfterEdit[0]?.anchorIndex).toBeGreaterThan(6)
		expect(replicaB.filesystem.getComments('/workspace/note.txt')).toEqual(commentsAfterEdit)

		replicaA.filesystem.rename('/workspace/note.txt', '/workspace/review.txt')
		expect(() => replicaB.filesystem.getComments('/workspace/note.txt')).toThrow(EntryNotFoundError)
		expect(replicaB.filesystem.getComments('/workspace/review.txt')).toEqual(
			replicaA.filesystem.getComments('/workspace/review.txt'),
		)

		const replyId = replicaB.filesystem.replyToComment('/workspace/review.txt', commentId, 'Looks good', 'bob')
		expect(replicaA.filesystem.getComments('/workspace/review.txt')).toEqual(
			replicaB.filesystem.getComments('/workspace/review.txt'),
		)
		expect(replicaA.filesystem.getComments('/workspace/review.txt')[0]).toMatchObject({
			replies: [
				{
					id: replyId,
					parentId: commentId,
					author: 'bob',
					body: 'Looks good',
				},
			],
		})

		replicaA.filesystem.resolveComment('/workspace/review.txt', commentId, 'carol')
		expect(replicaB.filesystem.getComments('/workspace/review.txt')).toEqual(
			replicaA.filesystem.getComments('/workspace/review.txt'),
		)
		expect(replicaB.filesystem.getComments('/workspace/review.txt')[0]).toMatchObject({
			resolved: true,
			resolvedBy: 'carol',
		})

		await disconnectSessions(sessionA, sessionB)
	})

	test('propagates awareness state without mutating persisted filesystem state', async () => {
		const { replicaA, replicaB, sessionA, sessionB } = await connectReplicas(harness)

		replicaA.filesystem.mkdir('/workspace')
		replicaA.filesystem.createFile('/workspace/note.txt', 'hello world')
		const beforeA = snapshotFilesystem(replicaA.filesystem)
		const beforeB = snapshotFilesystem(replicaB.filesystem)

		replicaA.filesystem.setLocalPresence({
			user: { id: 'agent-a', name: 'Agent A' },
			activePath: '/workspace/note.txt',
			cursor: { path: '/workspace/note.txt', index: 6, length: 5 },
		})
		replicaA.filesystem.setLocalSelection('/workspace/note.txt', 6, 11)

		const remoteState = findPresenceState(replicaB, 'agent-a')
		expect(remoteState).toBeDefined()
		expect(remoteState).toMatchObject({
			presence: {
				user: { id: 'agent-a', name: 'Agent A' },
				activePath: '/workspace/note.txt',
				cursor: { path: '/workspace/note.txt', index: 6, length: 5 },
			},
		})
		expect(resolveSelectionForReplica(replicaB, 'agent-a', '/workspace/note.txt')).toEqual({
			anchor: 6,
			head: 11,
		})
		expect(snapshotFilesystem(replicaA.filesystem)).toEqual(beforeA)
		expect(snapshotFilesystem(replicaB.filesystem)).toEqual(beforeB)

		await disconnectSessions(sessionA, sessionB)
	})
}

function createBindingFixture(options: { awareness?: boolean } = {}): BindingFixture {
	const replica = createReplica(options)
	replica.filesystem.mkdir('/workspace')
	replica.filesystem.createFile('/workspace/alpha.txt', 'alpha')
	replica.filesystem.createFile('/workspace/beta.txt', 'beta')

	const alphaContentId = replica.filesystem.stat('/workspace/alpha.txt').contentId
	const betaContentId = replica.filesystem.stat('/workspace/beta.txt').contentId
	if (!alphaContentId || !betaContentId) {
		throw new Error('expected file content identifiers')
	}

	return {
		filesystem: replica.filesystem,
		contentIds: [alphaContentId, betaContentId],
	}
}

async function connectReplicas(harness: TransportHarness): Promise<{
	replicaA: Replica
	replicaB: Replica
	sessionA: DurableStreamsClientSession
	sessionB: DurableStreamsClientSession
}> {
	const client = harness.createClient()
	const replicaA = createReplica()
	const replicaB = createReplica()
	const sessionA = await client.connect({ filesystem: replicaA.filesystem })
	const sessionB = await client.connect({ filesystem: replicaB.filesystem })

	return {
		replicaA,
		replicaB,
		sessionA,
		sessionB,
	}
}

function createReplica(options: { awareness?: boolean } = {}): Replica {
	const doc = new Y.Doc()
	const awareness = options.awareness === false ? null : new Awareness(doc)
	const filesystem = new YjsFilesystem({ doc, awareness })
	return { filesystem, awareness, doc }
}

function expectedBindings(
	mode: DurableStreamsTransportMode,
	contentIds: string[],
	withAwareness: boolean,
): DurableStreamsBindingDescriptor[] {
	const descriptors: DurableStreamsBindingDescriptor[] = [
		{
			kind: 'root',
			channelId: mode === 'single-stream' ? 'filesystem' : '_root',
		},
	]

	if (withAwareness) {
		descriptors.push({
			kind: 'awareness',
			channelId: mode === 'single-stream' ? 'filesystem.awareness' : '_awareness',
		})
	}

	for (const contentId of [...contentIds].sort((left, right) => left.localeCompare(right))) {
		descriptors.push({
			kind: 'content',
			contentId,
			channelId: mode === 'single-stream' ? 'filesystem' : `_file/${contentId}`,
		})
	}

	return sortBindingDescriptors(descriptors)
}

function filesystemMethodNames(filesystem: YjsFilesystem): string[] {
	return Object.getOwnPropertyNames(Object.getPrototypeOf(filesystem))
		.filter((name) => name !== 'constructor')
		.sort((left, right) => left.localeCompare(right))
}

async function disconnectSessions(...sessions: DurableStreamsClientSession[]): Promise<void> {
	for (const session of sessions) {
		await session.disconnect()
	}
}

function findPresenceState(replica: Replica, userId: string): Record<string, unknown> | undefined {
	if (!replica.awareness) {
		return undefined
	}

	for (const state of replica.awareness.getStates().values()) {
		if (!isRecord(state)) {
			continue
		}

		const presence = state.presence
		if (!isRecord(presence)) {
			continue
		}

		const user = presence.user
		if (!isRecord(user) || user.id !== userId) {
			continue
		}

		return state
	}

	return undefined
}

function resolveSelectionForReplica(
	replica: Replica,
	userId: string,
	path: string,
): { anchor: number; head: number } | undefined {
	const state = findPresenceState(replica, userId)
	if (!state) {
		return undefined
	}

	const selection = state.selection
	if (!isRecord(selection)) {
		return undefined
	}

	const contentId = replica.filesystem.stat(path).contentId
	if (!contentId) {
		return undefined
	}

	const ytext = replica.doc.getMap<Y.Doc>('contentDocs').get(contentId)?.getText('content')
	if (!ytext) {
		return undefined
	}

	return resolveLocalSelectionState(
		ytext,
		selection as Parameters<typeof resolveLocalSelectionState>[1],
	)
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
