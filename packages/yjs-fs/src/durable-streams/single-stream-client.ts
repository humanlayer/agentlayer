import {
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	type Awareness,
} from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { DurableStreamsClientOptions } from '../surface'
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

const FILESYSTEM_CHANNEL_ID = 'filesystem'
const AWARENESS_CHANNEL_ID = 'filesystem.awareness'

type SingleStreamFilesystemMessage = {
	channelId: typeof FILESYSTEM_CHANNEL_ID
	senderId: string
	binding:
		| {
				kind: 'root'
		  }
		| {
				kind: 'content'
				contentId: ContentId
		  }
	update: Uint8Array
}

type SingleStreamAwarenessMessage = {
	channelId: typeof AWARENESS_CHANNEL_ID
	senderId: string
	binding: {
		kind: 'awareness'
	}
	update: Uint8Array
}

export type SingleStreamMessage = SingleStreamFilesystemMessage | SingleStreamAwarenessMessage

export interface SingleStreamTransport {
	subscribe(listener: (message: SingleStreamMessage) => void): () => void
	publish(message: SingleStreamMessage): void
}

export type SingleStreamClientOptions = DurableStreamsClientOptions & {
	transport: SingleStreamTransport
}

export function createSingleStreamDurableStreamsClient(
	options: Omit<SingleStreamClientOptions, 'mode'>,
): DurableStreamsClient {
	return {
		mode: 'single-stream',
		connect({ filesystem }) {
			return new SingleStreamDurableStreamsClientSession(filesystem, {
				mode: 'single-stream',
				transport: options.transport,
			})
		},
	}
}

export function createInMemorySingleStreamTransport(): SingleStreamTransport {
	return new InMemorySingleStreamTransport()
}

class SingleStreamDurableStreamsClientSession implements DurableStreamsClientSession {
	readonly mode = 'single-stream' as const

	private readonly senderId = crypto.randomUUID()
	private readonly remoteOrigin = Symbol('single-stream-remote-origin')
	private readonly bindings = new Map<string, DurableStreamsBindingDescriptor>()
	private readonly contentDocUnsubscribers = new Map<ContentId, () => void>()
	private readonly pendingContentUpdates = new Map<ContentId, Uint8Array[]>()
	private readonly transport: SingleStreamTransport
	private readonly filesystem: YjsFilesystem
	private readonly unsubscribeTransport: () => void
	private readonly stopObservingContentDocs: () => void
	private readonly stopRootUpdates: () => void
	private readonly stopAwarenessUpdates: () => void

	constructor(filesystem: YjsFilesystem, options: SingleStreamClientOptions) {
		this.transport = options.transport
		this.filesystem = filesystem
		this.unsubscribeTransport = this.transport.subscribe((message) => {
			this.receiveMessage(message)
		})

		this.setBinding(getRootBindingTarget(filesystem))
		this.stopRootUpdates = this.bindRootUpdates()

		const awarenessTarget = getAwarenessBindingTarget(filesystem)
		if (awarenessTarget) {
			this.setBinding(awarenessTarget)
			this.stopAwarenessUpdates = this.bindAwarenessUpdates(awarenessTarget.awareness)
		} else {
			this.stopAwarenessUpdates = () => {}
		}

		for (const contentTarget of listContentBindingTargets(filesystem)) {
			this.setBinding(contentTarget)
			this.bindContentDoc(contentTarget)
			this.flushPendingContentUpdates(contentTarget.contentId)
		}

		this.stopObservingContentDocs = observeContentBindingTargets(filesystem, (change) => {
			for (const contentId of change.removed) {
				this.bindings.delete(contentBindingMapKey(contentId))
				this.pendingContentUpdates.delete(contentId)
				this.unbindContentDoc(contentId)
			}

			for (const target of change.added) {
				this.setBinding(target)
				this.bindContentDoc(target)
				this.flushPendingContentUpdates(target.contentId)
				this.publishContentState(target)
			}
		})

		this.publishRootState()
		for (const target of listContentBindingTargets(filesystem)) {
			this.publishContentState(target)
		}
		this.publishLocalAwarenessState()
	}

	describeBindings(): DurableStreamsBindingDescriptor[] {
		return sortBindingDescriptors(this.bindings.values())
	}

	disconnect(): void {
		this.stopObservingContentDocs()
		this.stopRootUpdates()
		this.stopAwarenessUpdates()
		for (const stop of this.contentDocUnsubscribers.values()) {
			stop()
		}
		this.contentDocUnsubscribers.clear()
		this.pendingContentUpdates.clear()
		this.unsubscribeTransport()
		this.bindings.clear()
	}

	private bindRootUpdates(): () => void {
		const listener = (update: Uint8Array, origin: unknown) => {
			if (origin === this.remoteOrigin) {
				return
			}
			this.transport.publish({
				channelId: FILESYSTEM_CHANNEL_ID,
				senderId: this.senderId,
				binding: { kind: 'root' },
				update: copyUint8Array(update),
			})
		}

		this.filesystem.doc.on('update', listener)
		return () => {
			this.filesystem.doc.off('update', listener)
		}
	}

	private bindContentDoc(target: DurableStreamsContentBindingTarget): void {
		if (this.contentDocUnsubscribers.has(target.contentId)) {
			return
		}

		const listener = (update: Uint8Array, origin: unknown) => {
			if (origin === this.remoteOrigin) {
				return
			}
			this.transport.publish({
				channelId: FILESYSTEM_CHANNEL_ID,
				senderId: this.senderId,
				binding: {
					kind: 'content',
					contentId: target.contentId,
				},
				update: copyUint8Array(update),
			})
		}

		target.doc.on('update', listener)
		this.contentDocUnsubscribers.set(target.contentId, () => {
			target.doc.off('update', listener)
		})
	}

	private unbindContentDoc(contentId: ContentId): void {
		const unsubscribe = this.contentDocUnsubscribers.get(contentId)
		if (!unsubscribe) {
			return
		}

		unsubscribe()
		this.contentDocUnsubscribers.delete(contentId)
	}

	private bindAwarenessUpdates(awareness: Awareness): () => void {
		const listener = (
			changes: { added: number[]; updated: number[]; removed: number[] },
			origin: unknown,
		) => {
			if (origin === this.remoteOrigin) {
				return
			}

			const changedClients = [...changes.added, ...changes.updated, ...changes.removed]
			if (changedClients.length === 0) {
				return
			}

			this.transport.publish({
				channelId: AWARENESS_CHANNEL_ID,
				senderId: this.senderId,
				binding: { kind: 'awareness' },
				update: copyUint8Array(encodeAwarenessUpdate(awareness, changedClients)),
			})
		}

		awareness.on('update', listener)
		return () => {
			awareness.off('update', listener)
		}
	}

	private receiveMessage(message: SingleStreamMessage): void {
		if (message.senderId === this.senderId) {
			return
		}

		if (message.binding.kind === 'awareness') {
			if (this.filesystem.awareness) {
				applyAwarenessUpdate(this.filesystem.awareness, message.update, this.remoteOrigin)
			}
			return
		}

		if (message.binding.kind === 'root') {
			Y.applyUpdate(this.filesystem.doc, message.update, this.remoteOrigin)
			this.flushAllPendingContentUpdates()
			return
		}

		const contentDocs = this.filesystem.doc.getMap<Y.Doc>('contentDocs')
		const doc = contentDocs.get(message.binding.contentId)
		if (!doc) {
			const pending = this.pendingContentUpdates.get(message.binding.contentId) ?? []
			pending.push(copyUint8Array(message.update))
			this.pendingContentUpdates.set(message.binding.contentId, pending)
			return
		}

		Y.applyUpdate(doc, message.update, this.remoteOrigin)
	}

	private flushAllPendingContentUpdates(): void {
		for (const contentId of this.pendingContentUpdates.keys()) {
			this.flushPendingContentUpdates(contentId)
		}
	}

	private flushPendingContentUpdates(contentId: ContentId): void {
		const updates = this.pendingContentUpdates.get(contentId)
		if (!updates || updates.length === 0) {
			return
		}

		const contentDocs = this.filesystem.doc.getMap<Y.Doc>('contentDocs')
		const doc = contentDocs.get(contentId)
		if (!doc) {
			return
		}

		for (const update of updates) {
			Y.applyUpdate(doc, update, this.remoteOrigin)
		}
		this.pendingContentUpdates.delete(contentId)
	}

	private publishRootState(): void {
		this.transport.publish({
			channelId: FILESYSTEM_CHANNEL_ID,
			senderId: this.senderId,
			binding: { kind: 'root' },
			update: copyUint8Array(Y.encodeStateAsUpdate(this.filesystem.doc)),
		})
	}

	private publishContentState(target: DurableStreamsContentBindingTarget): void {
		this.transport.publish({
			channelId: FILESYSTEM_CHANNEL_ID,
			senderId: this.senderId,
			binding: {
				kind: 'content',
				contentId: target.contentId,
			},
			update: copyUint8Array(Y.encodeStateAsUpdate(target.doc)),
		})
	}

	private publishLocalAwarenessState(): void {
		const awareness = this.filesystem.awareness
		if (!awareness) {
			return
		}

		const localState = awareness.getLocalState()
		if (!localState) {
			return
		}

		this.transport.publish({
			channelId: AWARENESS_CHANNEL_ID,
			senderId: this.senderId,
			binding: { kind: 'awareness' },
			update: copyUint8Array(encodeAwarenessUpdate(awareness, [awareness.clientID])),
		})
	}

	private setBinding(
		target:
			| ReturnType<typeof getRootBindingTarget>
			| NonNullable<ReturnType<typeof getAwarenessBindingTarget>>
			| DurableStreamsContentBindingTarget,
	): void {
		const descriptor = descriptorForTarget(target)
		this.bindings.set(bindingDescriptorMapKey(descriptor), descriptor)
	}
}

class InMemorySingleStreamTransport implements SingleStreamTransport {
	private readonly history: SingleStreamFilesystemMessage[] = []
	private readonly listeners = new Set<(message: SingleStreamMessage) => void>()

	subscribe(listener: (message: SingleStreamMessage) => void): () => void {
		for (const message of this.history) {
			listener(copyMessage(message))
		}
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	publish(message: SingleStreamMessage): void {
		const storedMessage = copyMessage(message)
		if (storedMessage.channelId === FILESYSTEM_CHANNEL_ID) {
			this.history.push(storedMessage)
		}
		for (const listener of this.listeners) {
			listener(copyMessage(storedMessage))
		}
	}
}

function descriptorForTarget(
	target:
		| ReturnType<typeof getRootBindingTarget>
		| NonNullable<ReturnType<typeof getAwarenessBindingTarget>>
		| DurableStreamsContentBindingTarget,
): DurableStreamsBindingDescriptor {
	switch (target.kind) {
		case 'root':
			return {
				kind: 'root',
				channelId: FILESYSTEM_CHANNEL_ID,
			}
		case 'awareness':
			return {
				kind: 'awareness',
				channelId: AWARENESS_CHANNEL_ID,
			}
		case 'content':
			return {
				kind: 'content',
				contentId: target.contentId,
				channelId: FILESYSTEM_CHANNEL_ID,
			}
	}
}

function bindingDescriptorMapKey(descriptor: DurableStreamsBindingDescriptor): string {
	if (descriptor.kind === 'content') {
		return contentBindingMapKey(descriptor.contentId)
	}

	return descriptor.kind
}

function contentBindingMapKey(contentId: ContentId): string {
	return `content:${contentId}`
}

function copyMessage(message: SingleStreamMessage): SingleStreamMessage {
	if (message.channelId === FILESYSTEM_CHANNEL_ID) {
		if (message.binding.kind === 'content') {
			return {
				channelId: FILESYSTEM_CHANNEL_ID,
				senderId: message.senderId,
				binding: {
					kind: 'content',
					contentId: message.binding.contentId,
				},
				update: copyUint8Array(message.update),
			}
		}

		return {
			channelId: FILESYSTEM_CHANNEL_ID,
			senderId: message.senderId,
			binding: { kind: 'root' },
			update: copyUint8Array(message.update),
		}
	}

	return {
		channelId: AWARENESS_CHANNEL_ID,
		senderId: message.senderId,
		binding: { kind: 'awareness' },
		update: copyUint8Array(message.update),
	}
}

function copyUint8Array(update: Uint8Array): Uint8Array {
	return Uint8Array.from(update)
}
