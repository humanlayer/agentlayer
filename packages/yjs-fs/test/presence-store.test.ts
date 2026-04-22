import { describe, expect, test } from 'bun:test'
import { colorFromId, PresenceStore } from '@humanlayer/yjs-fs'
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

		expect(store.getLocalPresence()).toMatchObject({
			user: { id: 'agent-1', name: 'Agent One', color: colorFromId('agent-1') },
			activePath: '/workspace/note.txt',
		})
		expect(store.getLocalSelection(text)).toEqual({ anchor: 6, head: 11 })

		store.clearLocalSelection()
		expect(store.getLocalSelection(text)).toBeUndefined()
	})
})
