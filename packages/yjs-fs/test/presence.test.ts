import { describe, expect, test } from 'bun:test'
import {
	colorFromId,
	getLocalPresenceState,
	getLocalSelectionState,
	resolveLocalSelectionState,
	YjsFilesystem,
} from '@humanlayer/yjs-fs'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { snapshotFilesystem } from './support/snapshot'

function createAwareness(doc: Y.Doc): Awareness {
	return new Awareness(doc)
}

describe('YjsFilesystem presence', () => {
	test('stores local presence and selection without mutating persisted filesystem state', () => {
		const doc = new Y.Doc()
		const awareness = createAwareness(doc)
		const filesystem = new YjsFilesystem({ doc, awareness })
		filesystem.mkdir('/workspace')
		filesystem.createFile('/workspace/note.txt', 'hello world')
		const before = snapshotFilesystem(filesystem)

		filesystem.setLocalPresence({
			user: { id: 'agent-1', name: 'Agent One', color: colorFromId('agent-1') },
			activePath: '/workspace/note.txt',
			cursor: { path: '/workspace/note.txt', index: 6, length: 5 },
		})
		filesystem.setLocalSelection('/workspace/note.txt', 6, 11)

		expect(filesystem.getLocalPresence()).toMatchObject({
			user: { id: 'agent-1', name: 'Agent One', color: colorFromId('agent-1') },
			activePath: '/workspace/note.txt',
			cursor: { path: '/workspace/note.txt', index: 6, length: 5 },
		})
		expect(filesystem.getLocalSelection('/workspace/note.txt')).toEqual({ anchor: 6, head: 11 })
		expect(snapshotFilesystem(filesystem)).toEqual(before)

		filesystem.updateLocalPresence({ cwdPath: '/workspace', cursor: { index: 0, length: 5 } })
		expect(filesystem.getLocalPresence()).toMatchObject({
			user: { id: 'agent-1', name: 'Agent One', color: colorFromId('agent-1') },
			activePath: '/workspace/note.txt',
			cwdPath: '/workspace',
			cursor: { index: 0, length: 5, path: '/workspace/note.txt' },
		})
		expect(snapshotFilesystem(filesystem)).toEqual(before)

		filesystem.clearLocalSelection()
		expect(filesystem.getLocalSelection('/workspace/note.txt')).toBeUndefined()
		expect(snapshotFilesystem(filesystem)).toEqual(before)
	})

	test('exposes awareness attachment and typed local selection helpers', () => {
		const doc = new Y.Doc()
		const awareness = createAwareness(doc)
		const filesystem = new YjsFilesystem({ doc })

		filesystem.mkdir('/workspace')
		filesystem.createFile('/workspace/note.txt', 'hello world')
		filesystem.setAwareness(awareness)
		filesystem.setLocalPresence({
			user: { id: 'agent-a', color: colorFromId('agent-a') },
			activePath: '/workspace/note.txt',
			cursor: { path: '/workspace/note.txt', index: 0, length: 5 },
		})
		filesystem.setLocalSelection('/workspace/note.txt', 2, 8)

		const selectionState = getLocalSelectionState(awareness)
		const selectionDoc = doc.getMap<Y.Doc>('contentDocs').get(filesystem.stat('/workspace/note.txt').contentId!)
		const ytext = selectionDoc?.getText('content')

		expect(filesystem.awareness).toBe(awareness)
		expect(getLocalPresenceState(awareness)).toMatchObject({
			user: { id: 'agent-a', color: colorFromId('agent-a') },
			activePath: '/workspace/note.txt',
		})
		expect(selectionState).not.toBeNull()
		expect(ytext).toBeDefined()
		expect(resolveLocalSelectionState(ytext!, selectionState)).toEqual({ anchor: 2, head: 8 })
		expect(filesystem.getLocalSelection('/workspace/note.txt')).toEqual({ anchor: 2, head: 8 })
	})

	test('behaves identically when awareness is not attached', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')
		filesystem.createFile('/workspace/note.txt', 'hello world')
		const before = snapshotFilesystem(filesystem)

		filesystem.setLocalPresence({ user: { id: 'offline-agent' } })
		filesystem.updateLocalPresence({ activePath: '/workspace/note.txt' })
		filesystem.setLocalSelection('/workspace/note.txt', 0, 5)
		filesystem.clearLocalSelection()

		expect(filesystem.awareness).toBeNull()
		expect(filesystem.getLocalPresence()).toBeNull()
		expect(filesystem.getLocalSelection('/workspace/note.txt')).toBeUndefined()
		expect(snapshotFilesystem(filesystem)).toEqual(before)
	})
})
