import { YjsProvider } from '@durable-streams/y-durable-streams'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { YjsFilesystemSessionProvider } from '@humanlayer/yjs-fs-react'
import type React from 'react'
import { type PropsWithChildren, useCallback } from 'react'
import { Awareness } from 'y-protocols/awareness.js'
import * as Y from 'yjs'
import { getOrCreateLocalUser } from '../lib/collaboration'

export const FilesystemProvider: React.FC<PropsWithChildren> = ({ children }) => {
	const createSession = useCallback(async () => {
		const doc = new Y.Doc()
		const awareness = new Awareness(doc)
		const localUser = getOrCreateLocalUser()
		const initializeLocalPresence = (filesystem?: YjsFilesystem) => {
			if (filesystem) {
				filesystem.setLocalPresence({ user: localUser })
			} else {
				awareness.setLocalStateField('presence', { user: localUser })
			}
			awareness.setLocalStateField('user', localUser)
		}

		initializeLocalPresence()
		const docId = new URLSearchParams(window.location.search).get('doc') ?? 'default-workspace'

		const serviceName = 'yjs-fs-editor'
		const yServerOrigin = import.meta.env.Y_SERVER_ORIGIN ?? 'https://localhost:4000'
		const provider = new YjsProvider({
			doc,
			awareness,
			baseUrl: `${yServerOrigin}/v1/yjs/${serviceName}`,
			docId,
			connect: false,
			liveMode: 'long-poll',
		})

		await provider.connect()
		const filesystem = new YjsFilesystem({ doc, awareness })
		initializeLocalPresence(filesystem)

		return {
			filesystem,
			awareness,
			provider,
			destroy: async () => {
				await provider.flush()
				provider.destroy()
			},
		}
	}, [])

	return (
		<YjsFilesystemSessionProvider createSession={createSession} loading={<div>Loading...</div>}>
			{children}
		</YjsFilesystemSessionProvider>
	)
}
