import type { YjsFilesystem } from '../filesystem'
import type { DurableStreamsClientOptions } from '../surface'
import {
	type DurableStreamsBindingDescriptor,
	type DurableStreamsClient,
	type DurableStreamsClientSession,
	type DurableStreamsContentBindingTarget,
	getAwarenessBindingTarget,
	getRootBindingTarget,
	listContentBindingTargets,
	observeContentBindingTargets,
	sortBindingDescriptors,
} from './shared'

export type { DurableStreamsClientOptions }
export type {
	DurableStreamsBindingDescriptor,
	DurableStreamsClient,
	DurableStreamsClientSession,
	DurableStreamsTransportMode,
} from './shared'

export function defineDurableStreamsClient(options: DurableStreamsClientOptions): DurableStreamsClient {
	return {
		mode: options.mode,
		connect({ filesystem }) {
			return createDurableStreamsClientSession(filesystem, options)
		},
	}
}

class StaticDurableStreamsClientSession implements DurableStreamsClientSession {
	readonly mode
	private readonly bindings = new Map<string, DurableStreamsBindingDescriptor>()
	private readonly stopObservingContentDocs: () => void

	constructor(filesystem: YjsFilesystem, options: DurableStreamsClientOptions) {
		this.mode = options.mode
		this.setBinding(getRootBindingTarget(filesystem), options)

		const awarenessTarget = getAwarenessBindingTarget(filesystem)
		if (awarenessTarget) {
			this.setBinding(awarenessTarget, options)
		}

		for (const contentTarget of listContentBindingTargets(filesystem)) {
			this.setBinding(contentTarget, options)
		}

		this.stopObservingContentDocs = observeContentBindingTargets(filesystem, (change) => {
			for (const contentId of change.removed) {
				this.bindings.delete(contentBindingMapKey(contentId))
			}

			for (const target of change.added) {
				this.setBinding(target, options)
			}
		})
	}

	describeBindings(): DurableStreamsBindingDescriptor[] {
		return sortBindingDescriptors(this.bindings.values())
	}

	disconnect(): void {
		this.stopObservingContentDocs()
		this.bindings.clear()
	}

	private setBinding(
		target:
			| ReturnType<typeof getRootBindingTarget>
			| NonNullable<ReturnType<typeof getAwarenessBindingTarget>>
			| DurableStreamsContentBindingTarget,
		options: DurableStreamsClientOptions,
	): void {
		const descriptor = descriptorForTarget(target, options)
		this.bindings.set(bindingDescriptorMapKey(descriptor), descriptor)
	}
}

function createDurableStreamsClientSession(
	filesystem: YjsFilesystem,
	options: DurableStreamsClientOptions,
): DurableStreamsClientSession {
	return new StaticDurableStreamsClientSession(filesystem, options)
}

function descriptorForTarget(
	target:
		| ReturnType<typeof getRootBindingTarget>
		| NonNullable<ReturnType<typeof getAwarenessBindingTarget>>
		| DurableStreamsContentBindingTarget,
	options: DurableStreamsClientOptions,
): DurableStreamsBindingDescriptor {
	switch (target.kind) {
		case 'root':
			return {
				kind: 'root',
				channelId: rootChannelId(options),
			}
		case 'awareness':
			return {
				kind: 'awareness',
				channelId: awarenessChannelId(options),
			}
		case 'content':
			return {
				kind: 'content',
				contentId: target.contentId,
				channelId: contentChannelId(options, target.contentId),
			}
	}
}

function rootChannelId(options: DurableStreamsClientOptions): string {
	return options.mode === 'single-stream' ? 'filesystem' : '_root'
}

function awarenessChannelId(options: DurableStreamsClientOptions): string {
	return options.mode === 'single-stream' ? 'filesystem.awareness' : '_awareness'
}

function contentChannelId(options: DurableStreamsClientOptions, contentId: string): string {
	return options.mode === 'single-stream' ? 'filesystem' : `_file/${contentId}`
}

function bindingDescriptorMapKey(descriptor: DurableStreamsBindingDescriptor): string {
	if (descriptor.kind === 'content') {
		return contentBindingMapKey(descriptor.contentId)
	}

	return descriptor.kind
}

function contentBindingMapKey(contentId: string): string {
	return `content:${contentId}`
}
