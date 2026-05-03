import type { EntryDirent, EntryStat, FilesystemTreeNode, YjsFilesystem } from '@humanlayer/yjs-fs'
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'

/** Connection state reported by a Yjs transport provider. */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected'

type ProviderStatusHandler = (status: ConnectionStatus) => void
type ProviderSyncedHandler = (synced: boolean) => void

type ProviderStatusObservable = {
	connected?: boolean
	connecting?: boolean
	synced?: boolean
	on?: ((event: 'status', listener: ProviderStatusHandler) => void) &
		((event: 'synced', listener: ProviderSyncedHandler) => void)
	off?: ((event: 'status', listener: ProviderStatusHandler) => void) &
		((event: 'synced', listener: ProviderSyncedHandler) => void)
}

/** React context value shared by the filesystem bindings provider. */
export type YjsFilesystemContextValue<TProvider = unknown> = {
	filesystem: YjsFilesystem
	awareness: Awareness | null
	provider: TProvider | null
}

/** Session object used by the session-creating provider. */
export type YjsFilesystemSession<TProvider = unknown> = YjsFilesystemContextValue<TProvider> & {
	/** Optional cleanup invoked when the provider unmounts or recreates the session. */
	destroy?: () => void | Promise<void>
}

type YjsFilesystemProviderProps<TProvider = unknown> = {
	children: ReactNode
	filesystem: YjsFilesystem
	awareness?: Awareness | null
	provider?: TProvider | null
}

type YjsFilesystemSessionProviderProps<TProvider = unknown> = {
	children: ReactNode
	createSession: () => YjsFilesystemSession<TProvider> | Promise<YjsFilesystemSession<TProvider>>
	loading?: ReactNode
	renderError?: (error: unknown) => ReactNode
}

const YjsFilesystemContext = createContext<YjsFilesystemContextValue | null>(null)

function noop(): void {}

function getProviderStatus(provider: unknown): ConnectionStatus {
	const observable = provider as ProviderStatusObservable | null | undefined
	if (observable?.connected) {
		return 'connected'
	}
	if (observable?.connecting) {
		return 'connecting'
	}
	return 'disconnected'
}

function getProviderSynced(provider: unknown): boolean {
	const observable = provider as ProviderStatusObservable | null | undefined
	return observable?.synced ?? false
}

function subscribeProviderStatus(provider: unknown, onStoreChange: () => void): () => void {
	const observable = provider as ProviderStatusObservable | null | undefined
	if (!observable?.on || !observable.off) {
		return noop
	}

	const handleStatus: ProviderStatusHandler = () => {
		onStoreChange()
	}

	observable.on('status', handleStatus)
	return () => {
		observable.off?.('status', handleStatus)
	}
}

function subscribeProviderSynced(provider: unknown, onStoreChange: () => void): () => void {
	const observable = provider as ProviderStatusObservable | null | undefined
	if (!observable?.on || !observable.off) {
		return noop
	}

	const handleSynced: ProviderSyncedHandler = () => {
		onStoreChange()
	}

	observable.on('synced', handleSynced)
	return () => {
		observable.off?.('synced', handleSynced)
	}
}

function subscribeAwareness(awareness: Awareness | null, onStoreChange: () => void): () => void {
	if (!awareness) {
		return noop
	}

	const handleChange = () => {
		onStoreChange()
	}

	awareness.on('change', handleChange)
	return () => {
		awareness.off('change', handleChange)
	}
}

function useSubscriptionVersion(subscribe: (onStoreChange: () => void) => () => void): number {
	const [version, setVersion] = useState(0)

	useEffect(() => {
		return subscribe(() => {
			setVersion((currentVersion) => currentVersion + 1)
		})
	}, [subscribe])

	return version
}

function useYjsFilesystemContext<TProvider = unknown>(): YjsFilesystemContextValue<TProvider> {
	const context = useContext(YjsFilesystemContext)
	if (!context) {
		throw new Error('YjsFilesystemProvider is missing from the React tree')
	}
	return context as YjsFilesystemContextValue<TProvider>
}

/**
 * Provides an already-created Yjs filesystem session to React descendants.
 *
 * Use this when your app owns session creation and wants to pass in the raw
 * `YjsFilesystem`, `Awareness`, and transport provider instances directly.
 */
export function YjsFilesystemProvider<TProvider = unknown>({
	children,
	filesystem,
	awareness,
	provider,
}: YjsFilesystemProviderProps<TProvider>) {
	return (
		<YjsFilesystemContext.Provider
			value={{
				filesystem,
				awareness: awareness ?? filesystem.awareness,
				provider: provider ?? null,
			}}
		>
			{children}
		</YjsFilesystemContext.Provider>
	)
}

/**
 * Creates a Yjs filesystem session on mount and provides it to descendants.
 *
 * This is the higher-level provider most apps should use. It lets the React
 * package own async session lifecycle while keeping transport setup pluggable.
 */
export function YjsFilesystemSessionProvider<TProvider = unknown>({
	children,
	createSession,
	loading = null,
	renderError,
}: YjsFilesystemSessionProviderProps<TProvider>) {
	const [session, setSession] = useState<YjsFilesystemSession<TProvider> | null>(null)
	const [error, setError] = useState<unknown>(null)

	useEffect(() => {
		let disposed = false
		let currentSession: YjsFilesystemSession<TProvider> | null = null

		void Promise.resolve(createSession())
			.then((createdSession) => {
				if (disposed) {
					void createdSession.destroy?.()
					return
				}

				currentSession = createdSession
				setSession(createdSession)
			})
			.catch((createError) => {
				if (disposed) {
					return
				}

				setError(createError)
			})

		return () => {
			disposed = true
			void currentSession?.destroy?.()
		}
	}, [createSession])

	if (error) {
		if (renderError) {
			return <>{renderError(error)}</>
		}

		throw error
	}

	if (!session) {
		return <>{loading}</>
	}

	return (
		<YjsFilesystemProvider
			filesystem={session.filesystem}
			awareness={session.awareness}
			provider={session.provider}
		>
			{children}
		</YjsFilesystemProvider>
	)
}

/** Returns the full session object currently provided to the tree. */
export function useYjsFilesystemSession<TProvider = unknown>(): YjsFilesystemContextValue<TProvider> {
	return useYjsFilesystemContext<TProvider>()
}

export const useFilesystemSession = useYjsFilesystemSession

/** Returns the raw `YjsFilesystem` instance for imperative filesystem operations. */
export function useYjsFilesystem(): YjsFilesystem {
	return useYjsFilesystemContext().filesystem
}

export const useFilesystem = useYjsFilesystem

/** Returns the raw shared `Y.Doc` that backs the current filesystem session. */
export function useFilesystemRawYDoc(): Y.Doc {
	return useYjsFilesystem().doc
}

export const useYjsDocument = useFilesystemRawYDoc
export const useDoc = useFilesystemRawYDoc

/** Returns the raw Yjs transport provider instance for the current session. */
export function useYjsProvider<TProvider = unknown>(): TProvider | null {
	return useYjsFilesystemContext<TProvider>().provider
}

export const useProvider = useYjsProvider

/** Returns the active Yjs awareness instance for presence and cursor state. */
export function useYjsAwareness(): Awareness {
	const awareness = useYjsFilesystemContext().awareness
	if (!awareness) {
		throw new Error('Awareness is not available in the current Yjs filesystem session')
	}
	return awareness
}

export const useAwareness = useYjsAwareness

/** Returns the current transport connection status. */
export function useConnectionStatus(): ConnectionStatus {
	const provider = useYjsProvider()
	return useSyncExternalStore(
		(onStoreChange: () => void) => subscribeProviderStatus(provider, onStoreChange),
		() => getProviderStatus(provider),
	)
}

/** Returns whether the current provider reports that initial sync has completed. */
export function useIsSynced(): boolean {
	const provider = useYjsProvider()
	return useSyncExternalStore(
		(onStoreChange: () => void) => subscribeProviderSynced(provider, onStoreChange),
		() => getProviderSynced(provider),
	)
}

export const useSynced = useIsSynced

/** Returns the immediate children for a directory path. */
export function useDirectoryEntries(path = '/'): EntryDirent[] {
	const filesystem = useYjsFilesystem()
	const version = useSubscriptionVersion(filesystem.subscribe.bind(filesystem))
	return useMemo(() => filesystem.list(path), [filesystem, path, version])
}

/** Returns a recursive filesystem tree rooted at the provided path. */
export function useFilesystemTree(path = '/'): FilesystemTreeNode {
	const filesystem = useYjsFilesystem()
	const version = useSubscriptionVersion(filesystem.subscribe.bind(filesystem))
	return useMemo(() => {
		try {
			return filesystem.tree(path)
		} catch {
			return {
				entryId: 'root',
				name: '',
				path,
				type: 'directory',
				children: [],
			}
		}
	}, [filesystem, path, version])
}

export const useTree = useFilesystemTree

/** Returns `stat` metadata for a path, or `null` when the path does not exist. */
export function useEntryStat(path: string): EntryStat | null {
	const filesystem = useYjsFilesystem()
	const version = useSubscriptionVersion((onStoreChange) => filesystem.subscribePath(path, onStoreChange))
	return useMemo(() => {
		try {
			return filesystem.stat(path)
		} catch {
			return null
		}
	}, [filesystem, path, version])
}

export const useStat = useEntryStat

/** Returns the raw collaborative `Y.Text` that backs a text file path. */
export function useYTextForFile(path: string): Y.Text | null {
	const filesystem = useYjsFilesystem()
	const version = useSubscriptionVersion((onStoreChange) => filesystem.subscribePath(path, onStoreChange))
	return useMemo(() => {
		try {
			return filesystem.getYTextForFile(path)
		} catch {
			return null
		}
	}, [filesystem, path, version])
}

export const useYText = useYTextForFile

/**
 * Derives a reactive value for a single file path.
 *
 * This is an advanced escape hatch for path-scoped values that do not warrant a
 * dedicated hook yet, such as comments or custom metadata projections.
 */
export function useFileSelector<T>(path: string, select: (filesystem: YjsFilesystem) => T): T {
	const filesystem = useYjsFilesystem()
	const version = useSubscriptionVersion((onStoreChange) => filesystem.subscribePath(path, onStoreChange))
	return useMemo(() => select(filesystem), [filesystem, select, version])
}

export const useFileSnapshot = useFileSelector
export const useSnapshot = useFileSelector

/** Returns a reactive copy of awareness states keyed by client id. */
export function useAwarenessStates<TState = unknown>(): Map<number, TState> {
	const awareness = useYjsFilesystemContext().awareness
	const version = useSubscriptionVersion((onStoreChange) => subscribeAwareness(awareness, onStoreChange))
	return useMemo(() => new Map((awareness?.getStates() ?? new Map()) as Map<number, TState>), [awareness, version])
}
