import { YjsProvider } from '@durable-streams/y-durable-streams'
import type { HeadersRecord } from '@durable-streams/client'
import * as Y from 'yjs'
import type { YjsFilesystem } from '../filesystem'
import type { ContentId } from '../types'
import {
	getAwarenessBindingTarget,
	getRootBindingTarget,
	listContentBindingTargets,
	observeContentBindingTargets,
	sortBindingDescriptors,
	type DurableStreamsBindingDescriptor,
	type DurableStreamsClient,
	type DurableStreamsClientSession,
	type DurableStreamsContentBindingTarget,
} from './shared'

const ROOT_CHANNEL_ID = '_root'
const AWARENESS_CHANNEL_ID = '_awareness'

export type PerDocumentDurableStreamsClientOptions = {
	baseUrl: string
	prefix?: string
	headers?: HeadersRecord
	liveMode?: 'sse' | 'long-poll'
}

export function createPerDocumentDurableStreamsClient(
	options: PerDocumentDurableStreamsClientOptions,
): DurableStreamsClient {
	return {
		mode: 'per-document',
		async connect({ filesystem }) {
			const session = new PerDocumentDurableStreamsClientSession(filesystem, options)
			await session.connect()
			return session
		},
	}
}

class PerDocumentDurableStreamsClientSession implements DurableStreamsClientSession {
	readonly mode = 'per-document' as const

	private readonly filesystem: YjsFilesystem
	private readonly options: PerDocumentDurableStreamsClientOptions
	private readonly bindings = new Map<string, DurableStreamsBindingDescriptor>()
	private readonly contentProviders = new Map<ContentId, YjsProvider>()
	private readonly stopObservingContentDocs: () => void
	private rootProvider: YjsProvider | null = null

	constructor(filesystem: YjsFilesystem, options: PerDocumentDurableStreamsClientOptions) {
		this.filesystem = filesystem
		this.options = options
		this.stopObservingContentDocs = observeContentBindingTargets(filesystem, (change) => {
			for (const contentId of change.removed) {
				this.unbindContent(contentId)
			}

			for (const target of change.added) {
				this.bindContent(target)
			}
		})
	}

	async connect(): Promise<void> {
		this.bindRoot()

		for (const target of listContentBindingTargets(this.filesystem)) {
			this.bindContent(target)
		}

		await this.rootProvider?.connect()
	}

	describeBindings(): DurableStreamsBindingDescriptor[] {
		return sortBindingDescriptors(this.bindings.values())
	}

	async disconnect(): Promise<void> {
		this.stopObservingContentDocs()

		for (const provider of this.contentProviders.values()) {
			await provider.disconnect()
			provider.destroy()
		}
		this.contentProviders.clear()

		if (this.rootProvider) {
			await this.rootProvider.disconnect()
			this.rootProvider.destroy()
			this.rootProvider = null
		}

		this.bindings.clear()
	}

	private bindRoot(): void {
		if (this.rootProvider) {
			return
		}

		const rootTarget = getRootBindingTarget(this.filesystem)
		const awarenessTarget = getAwarenessBindingTarget(this.filesystem)
		this.bindings.set('root', descriptorForRoot())

		if (awarenessTarget) {
			this.bindings.set('awareness', descriptorForAwareness())
		}

		this.rootProvider = new YjsProvider({
			doc: rootTarget.doc,
			awareness: awarenessTarget?.awareness,
			baseUrl: yjsBaseUrl(this.options),
			docId: rootDocId(this.options),
			headers: this.options.headers,
			liveMode: this.options.liveMode,
			connect: false,
		})
	}

	private bindContent(target: DurableStreamsContentBindingTarget): void {
		if (this.contentProviders.has(target.contentId)) {
			return
		}

		this.bindings.set(contentBindingMapKey(target.contentId), descriptorForContent(target.contentId))

		const provider = new YjsProvider({
			doc: target.doc,
			baseUrl: yjsBaseUrl(this.options),
			docId: contentDocId(this.options, target.contentId),
			headers: this.options.headers,
			liveMode: this.options.liveMode,
			connect: false,
		})

		this.contentProviders.set(target.contentId, provider)
		void provider.connect()
	}

	private unbindContent(contentId: ContentId): void {
		const provider = this.contentProviders.get(contentId)
		if (provider) {
			void provider.disconnect()
			provider.destroy()
			this.contentProviders.delete(contentId)
		}

		this.bindings.delete(contentBindingMapKey(contentId))
	}
}

function yjsBaseUrl(options: PerDocumentDurableStreamsClientOptions): string {
	return options.baseUrl.replace(/\/$/, '')
}

function prefix(options: PerDocumentDurableStreamsClientOptions): string {
	return options.prefix?.replace(/^\/+|\/+$/g, '') || 'yjs-fs'
}

function rootDocId(options: PerDocumentDurableStreamsClientOptions): string {
	return `${prefix(options)}/_root`
}

function contentDocId(options: PerDocumentDurableStreamsClientOptions, contentId: ContentId): string {
	return `${prefix(options)}/_file/${contentId}`
}

function descriptorForRoot(): DurableStreamsBindingDescriptor {
	return {
		kind: 'root',
		channelId: ROOT_CHANNEL_ID,
	}
}

function descriptorForAwareness(): DurableStreamsBindingDescriptor {
	return {
		kind: 'awareness',
		channelId: AWARENESS_CHANNEL_ID,
	}
}

function descriptorForContent(contentId: ContentId): DurableStreamsBindingDescriptor {
	return {
		kind: 'content',
		contentId,
		channelId: `_file/${contentId}`,
	}
}

function contentBindingMapKey(contentId: ContentId): string {
	return `content:${contentId}`
}
