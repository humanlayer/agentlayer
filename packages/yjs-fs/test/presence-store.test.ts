import { describe, expect, test } from 'bun:test'
import { ContentStore, colorFromId, PresenceStore } from '@humanlayer/yjs-fs'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'

describe('PresenceStore', () => {
	test('stores local presence and selection against awareness', () => {
		const doc = new Y.Doc()
		const awareness = new Awareness(doc)
		const text = doc.getText('content')
		text.insert(0, 'hello world')
		const store = new PresenceStore(awareness)

		store.setLocalPresence({
			user: { id: 'agent-1', name: 'Agent One', color: colorFromId('agent-1') },
			activePath: '/workspace/note.txt',
			cursor: { path: '/workspace/note.txt', index: 6, length: 5 },
		})
		store.setLocalSelection(text, 6, 11)

		expect(store.getAwareness()).toBe(awareness)
		expect(store.getLocalPresence()).toMatchObject({
			user: { id: 'agent-1', name: 'Agent One', color: colorFromId('agent-1') },
			activePath: '/workspace/note.txt',
		})
		expect(store.getLocalSelection(text)).toEqual({ anchor: 6, head: 11 })

		store.clearLocalSelection()
		expect(store.getLocalSelection(text)).toBeUndefined()
	})

	test('supports content helpers, awareness replacement, and unattached behavior', () => {
		const doc = new Y.Doc()
		const awareness = new Awareness(doc)
		const content = new ContentStore(doc)
		const created = content.create('hello world')
		const store = new PresenceStore()

		expect(store.getAwareness()).toBeNull()
		expect(store.updateLocalPresence({ activePath: '/note.txt' })).toBeNull()
		store.setLocalSelectionForContent(content, created.contentId, '/note.txt', 0, 5)
		expect(store.getLocalSelectionForContent(content, created.contentId, '/note.txt')).toBeUndefined()

		store.setAwareness(awareness)
		const updated = store.updateLocalPresence({
			user: { id: 'agent-2', color: colorFromId('agent-2') },
			activePath: '/note.txt',
			cursor: { path: '/note.txt', index: 0, length: 5 },
		})
		store.setLocalSelectionForContent(content, created.contentId, '/note.txt', 1, 4)

		expect(updated).toMatchObject({
			user: { id: 'agent-2', color: colorFromId('agent-2') },
			activePath: '/note.txt',
			cursor: { path: '/note.txt', index: 0, length: 5 },
		})
		expect(store.getLocalSelectionForContent(content, created.contentId, '/note.txt')).toEqual({
			anchor: 1,
			head: 4,
		})
	})
})
