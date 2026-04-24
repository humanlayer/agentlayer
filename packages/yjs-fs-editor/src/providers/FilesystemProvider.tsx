import { YjsProvider } from '@durable-streams/y-durable-streams'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { YjsFilesystemSessionProvider } from '@humanlayer/yjs-fs-react'
import type React from 'react'
import { type PropsWithChildren, useCallback } from 'react'
import { Awareness } from 'y-protocols/awareness.js'
import * as Y from 'yjs'

export const FilesystemProvider: React.FC<PropsWithChildren> = ({ children }) => {
	const createSession = useCallback(async () => {
		const doc = new Y.Doc()
		const awareness = new Awareness(doc)
		const filesystem = new YjsFilesystem({ doc, awareness })

		const serviceName = 'yjs-fs-editor'
		const yServerOrigin = import.meta.env.Y_SERVER_ORIGIN ?? 'https://localhost:4000'
		const provider = new YjsProvider({
			doc,
			awareness,
			baseUrl: `${yServerOrigin}/v1/yjs/${serviceName}`,
			docId: 'workspace-123',
			connect: false,
			liveMode: 'long-poll',
		})

		await provider.connect()

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
