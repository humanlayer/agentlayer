import { YjsProvider } from '@durable-streams/y-durable-streams'
import { RichMarkdownArtifactStore } from '@humanlayer/yjs-rich-markdown'
import { createContext, type PropsWithChildren, useContext, useEffect, useState } from 'react'
import { Awareness } from 'y-protocols/awareness.js'
import * as Y from 'yjs'
import { type AwarenessUser, getOrCreateLocalUser } from '../lib/collaboration'
import { patchProviderAwareness } from '../lib/provider-awareness'

export type ArtifactSession = {
	doc: Y.Doc
	store: RichMarkdownArtifactStore
	awareness: Awareness
	provider: YjsProvider
	localUser: AwarenessUser
	connectionStatus: 'connecting' | 'connected' | 'disconnected'
	isSynced: boolean
}

const ArtifactSessionContext = createContext<ArtifactSession | null>(null)

export function useArtifactSession(): ArtifactSession {
	const session = useContext(ArtifactSessionContext)
	if (!session) {
		throw new Error('useArtifactSession must be used within ArtifactProvider')
	}
	return session
}

export function ArtifactProvider({ children }: PropsWithChildren) {
	const [session, setSession] = useState<ArtifactSession | null>(null)
	const [error, setError] = useState<Error | null>(null)

	useEffect(() => {
		let destroyed = false
		let provider: YjsProvider | null = null

		async function init() {
			const doc = new Y.Doc()
			const awareness = new Awareness(doc)
			const store = new RichMarkdownArtifactStore(doc)
			const localUser = getOrCreateLocalUser()

			awareness.setLocalStateField('user', localUser)
			awareness.setLocalStateField('presence', { artifactPath: undefined })

			const docId = new URLSearchParams(window.location.search).get('doc') ?? 'rich-markdown-learning'
			const baseUrl = `${window.location.origin}/v1/yjs/rich-markdown-demo`

			provider = new YjsProvider({
				doc,
				awareness,
				baseUrl,
				docId,
				connect: false,
				liveMode: 'long-poll',
			})

			patchProviderAwareness(provider)

			const updateStatus = () => {
				if (destroyed) return
				setSession((prev) =>
					prev
						? {
								...prev,
								connectionStatus: provider!.connected
									? 'connected'
									: provider!.connecting
										? 'connecting'
										: 'disconnected',
								isSynced: provider!.synced,
							}
						: prev,
				)
			}

			provider.on('status', updateStatus)
			provider.on('synced', updateStatus)

			await provider.connect()

			if (destroyed) {
				provider.destroy()
				return
			}

			setSession({
				doc,
				store,
				awareness,
				provider,
				localUser,
				connectionStatus: provider.connected ? 'connected' : 'connecting',
				isSynced: provider.synced,
			})
		}

		init().catch((err) => {
			if (!destroyed) {
				setError(err)
			}
		})

		return () => {
			destroyed = true
			if (provider) {
				provider.flush().finally(() => provider?.destroy())
			}
		}
	}, [])

	if (error) {
		return (
			<div style={{ padding: 24, color: 'red' }}>
				<h2>Connection Error</h2>
				<pre>{error.message}</pre>
			</div>
		)
	}

	if (!session) {
		return (
			<div
				style={{ padding: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}
			>
				<div>Connecting to Durable Streams...</div>
			</div>
		)
	}

	return <ArtifactSessionContext.Provider value={session}>{children}</ArtifactSessionContext.Provider>
}
