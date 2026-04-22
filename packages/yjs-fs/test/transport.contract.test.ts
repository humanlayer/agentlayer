import { describe, expect, test } from 'bun:test'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import {
	defineDurableStreamsClient,
	type DurableStreamsBindingDescriptor,
	type DurableStreamsClient,
	type DurableStreamsTransportMode,
} from '@humanlayer/yjs-fs/durable-streams/client'
import { sortBindingDescriptors } from '@humanlayer/yjs-fs/durable-streams/shared'

type TransportHarness = {
	mode: DurableStreamsTransportMode
	client: DurableStreamsClient
}

type BindingFixture = {
	filesystem: YjsFilesystem
	awareness: Awareness
	rootDoc: Y.Doc
	contentIds: string[]
}

describe('durable streams transport contract', () => {
	for (const mode of ['single-stream', 'per-document'] as const) {
		describe(mode, () => {
			runTransportContractSuite({
				mode,
				client: defineDurableStreamsClient({ mode }),
			})
		})
	}
})

function runTransportContractSuite(harness: TransportHarness): void {
	test('describes root, awareness, and content bindings for the filesystem', async () => {
		const fixture = createBindingFixture()
		const session = await harness.client.connect({ filesystem: fixture.filesystem })

		expect(session.mode).toBe(harness.mode)
		expect(harness.client.mode).toBe(harness.mode)
		expect(sortBindingDescriptors(session.describeBindings())).toEqual(
			expectedBindings(harness.mode, fixture.contentIds, true),
		)

		session.disconnect()
	})

	test('tracks content binding additions and removals without changing filesystem API shape', async () => {
		const fixture = createBindingFixture()
		const baselineMethods = filesystemMethodNames(fixture.filesystem)
		const session = await harness.client.connect({ filesystem: fixture.filesystem })

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

		session.disconnect()
	})

	test('adds awareness binding only when awareness is configured', async () => {
		const withoutAwareness = createBindingFixture({ awareness: false })
		const session = await harness.client.connect({ filesystem: withoutAwareness.filesystem })

		expect(sortBindingDescriptors(session.describeBindings())).toEqual(
			expectedBindings(harness.mode, withoutAwareness.contentIds, false),
		)

		session.disconnect()
	})

	test('clears described bindings on disconnect', async () => {
		const fixture = createBindingFixture()
		const session = await harness.client.connect({ filesystem: fixture.filesystem })

		expect(session.describeBindings().length).toBeGreaterThan(0)
		session.disconnect()
		expect(session.describeBindings()).toEqual([])
	})
}

function createBindingFixture(options: { awareness?: boolean } = {}): BindingFixture {
	const rootDoc = new Y.Doc()
	const awareness = new Awareness(rootDoc)
	const filesystem = new YjsFilesystem({
		doc: rootDoc,
		awareness: options.awareness === false ? null : awareness,
	})

	filesystem.mkdir('/workspace')
	filesystem.createFile('/workspace/alpha.txt', 'alpha')
	filesystem.createFile('/workspace/beta.txt', 'beta')

	const alphaContentId = filesystem.stat('/workspace/alpha.txt').contentId
	const betaContentId = filesystem.stat('/workspace/beta.txt').contentId
	if (!alphaContentId || !betaContentId) {
		throw new Error('expected file content identifiers')
	}

	return {
		filesystem,
		awareness,
		rootDoc,
		contentIds: [alphaContentId, betaContentId],
	}
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
