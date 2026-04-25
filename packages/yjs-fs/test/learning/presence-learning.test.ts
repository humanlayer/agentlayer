import { describe, expect, test } from 'bun:test'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { YjsFilesystem } from '../../src'
import { waitForSync } from '../util/wait-for'
import { withYjsDurableStreamServer } from './fixture'

describe('Y.js Presence Learning Tests', () => {
	test('provider awareness with current fixture does not hydrate remote peers into awareness state', async () => {
		await withYjsDurableStreamServer(async ({ createProviderWithAwareness }) => {
			const docId = crypto.randomUUID()
			const { provider: provider1, awareness: awareness1 } = await createProviderWithAwareness({ docId })

			awareness1.setLocalStateField('presence', {
				user: { id: 'alice', name: 'Alice', color: '#ff0000' },
				activePath: '/README.md',
			})
			awareness1.setLocalStateField('user', { id: 'alice', name: 'Alice', color: '#ff0000' })

			await provider1.flush()

			const { provider: provider2, awareness: awareness2 } = await createProviderWithAwareness({ docId })

			await waitForSync(provider2)

			expect(Array.from(awareness1.getStates().keys())).toContain(awareness1.clientID)
			expect(Array.from(awareness2.getStates().keys())).toContain(awareness2.clientID)
			expect(Array.from(awareness2.getStates().keys())).not.toContain(awareness1.clientID)
		})
	})

	test('provider awareness still does not hydrate an already-present peer even after that peer rebroadcasts', async () => {
		await withYjsDurableStreamServer(async ({ createProviderWithAwareness }) => {
			const docId = crypto.randomUUID()
			const { provider: provider1, awareness: awareness1 } = await createProviderWithAwareness({ docId })

			awareness1.setLocalStateField('presence', {
				user: { id: 'alice', name: 'Alice', color: '#ff0000' },
				activePath: '/README.md',
			})
			awareness1.setLocalStateField('user', { id: 'alice', name: 'Alice', color: '#ff0000' })
			await provider1.flush()

			const { provider: provider2, awareness: awareness2 } = await createProviderWithAwareness({ docId })

			awareness2.setLocalStateField('presence', {
				user: { id: 'bob', name: 'Bob', color: '#00aa00' },
				activePath: '/README.md',
			})
			awareness2.setLocalStateField('user', { id: 'bob', name: 'Bob', color: '#00aa00' })
			await provider2.flush()

			expect(Array.from(awareness2.getStates().keys())).not.toContain(awareness1.clientID)

			awareness1.setLocalStateField('presence', {
				user: { id: 'alice', name: 'Alice', color: '#ff0000' },
				activePath: '/README-2.md',
			})
			await provider1.flush()

			expect(Array.from(awareness2.getStates().keys())).not.toContain(awareness1.clientID)
		})
	})

	test('filesystem presence helpers do not duplicate local awareness entries on repeated updates', async () => {
		await withYjsDurableStreamServer(async ({ createProviderWithAwareness }) => {
			const docId = crypto.randomUUID()
			const { provider, awareness } = await createProviderWithAwareness({ docId })
			const filesystem = new YjsFilesystem({ doc: provider.doc, awareness })

			filesystem.setLocalPresence({
				user: { id: 'alice', name: 'Alice', color: '#ff0000' },
				activePath: '/README.md',
			})
			filesystem.updateLocalPresence({ activePath: '/README.md' })
			filesystem.updateLocalPresence({ activeEntryId: 'entry-1' })
			filesystem.updateLocalPresence({ activePath: '/README-2.md' })

			const states = Array.from(awareness.getStates().entries())
			expect(states).toHaveLength(1)
			expect(states[0]?.[0]).toBe(awareness.clientID)
			expect(states[0]?.[1]).toMatchObject({
				presence: {
					user: { id: 'alice', name: 'Alice', color: '#ff0000' },
					activePath: '/README-2.md',
					activeEntryId: 'entry-1',
				},
			})
		})
	})

	test('awareness protocol can hold multiple client ids for the same persisted user id after reconnect-like updates', async () => {
		const observer = new Awareness(new Y.Doc())
		const oldSession = new Awareness(new Y.Doc())
		const newSession = new Awareness(new Y.Doc())

		oldSession.setLocalStateField('presence', {
			user: { id: 'bob', name: 'Bob', color: '#00aa00' },
			activePath: '/README.md',
		})
		newSession.setLocalStateField('presence', {
			user: { id: 'bob', name: 'Bob', color: '#00aa00' },
			activePath: '/README.md',
		})

		applyAwarenessUpdate(observer, encodeAwarenessUpdate(oldSession, [oldSession.clientID]), 'test')
		applyAwarenessUpdate(observer, encodeAwarenessUpdate(newSession, [newSession.clientID]), 'test')

		const bobStates = Array.from(observer.getStates().entries()).filter(([, state]) => {
			const presence = (state as { presence?: { user?: { id?: string } } }).presence
			return presence?.user?.id === 'bob'
		})

		expect(bobStates).toHaveLength(2)
		expect(new Set(bobStates.map(([clientId]) => clientId)).size).toBe(2)
	})
})
