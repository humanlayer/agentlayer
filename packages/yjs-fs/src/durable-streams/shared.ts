import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import type { YjsFilesystem } from '../filesystem'
import type { ContentId } from '../types'

export type DurableStreamsTransportMode = 'single-stream' | 'per-document'
export type DurableStreamsBindingKind = 'root' | 'awareness' | 'content'

export type DurableStreamsRootBindingTarget = {
	kind: 'root'
	doc: Y.Doc
	bindingKey: 'root'
}

export type DurableStreamsAwarenessBindingTarget = {
	kind: 'awareness'
	awareness: Awareness
	bindingKey: 'awareness'
}

export type DurableStreamsContentBindingTarget = {
	kind: 'content'
	contentId: ContentId
	value: unknown
	bindingKey: ContentId
}

export type DurableStreamsBindingTarget =
	| DurableStreamsRootBindingTarget
	| DurableStreamsAwarenessBindingTarget
	| DurableStreamsContentBindingTarget

export type DurableStreamsContentBindingChange = {
	added: DurableStreamsContentBindingTarget[]
	removed: ContentId[]
}

export type DurableStreamsBindingDescriptor =
	| {
			kind: 'root'
			channelId: string
	  }
	| {
			kind: 'awareness'
			channelId: string
	  }
	| {
			kind: 'content'
			channelId: string
			contentId: ContentId
	  }

export type DurableStreamsClientBinding = {
	filesystem: YjsFilesystem
}

export interface DurableStreamsClientSession {
	readonly mode: DurableStreamsTransportMode
	describeBindings(): DurableStreamsBindingDescriptor[]
	disconnect(): Promise<void> | void
}

export interface DurableStreamsClient {
	readonly mode: DurableStreamsTransportMode
	connect(binding: DurableStreamsClientBinding): Promise<DurableStreamsClientSession> | DurableStreamsClientSession
}

export function getRootBindingTarget(filesystem: YjsFilesystem): DurableStreamsRootBindingTarget {
	return {
		kind: 'root',
		doc: filesystem.doc,
		bindingKey: 'root',
	}
}

export function getAwarenessBindingTarget(filesystem: YjsFilesystem): DurableStreamsAwarenessBindingTarget | undefined {
	if (!filesystem.awareness) {
		return undefined
	}

	return {
		kind: 'awareness',
		awareness: filesystem.awareness,
		bindingKey: 'awareness',
	}
}

export function listContentBindingTargets(filesystem: YjsFilesystem): DurableStreamsContentBindingTarget[] {
	return Array.from(getFilesMap(filesystem).entries())
		.map(([contentId, value]) => ({
			kind: 'content' as const,
			contentId,
			value,
			bindingKey: contentId,
		}))
		.sort((left, right) => left.contentId.localeCompare(right.contentId))
}

export function listDurableStreamsBindingTargets(filesystem: YjsFilesystem): DurableStreamsBindingTarget[] {
	const targets: DurableStreamsBindingTarget[] = [getRootBindingTarget(filesystem)]
	const awarenessTarget = getAwarenessBindingTarget(filesystem)

	if (awarenessTarget) {
		targets.push(awarenessTarget)
	}

	targets.push(...listContentBindingTargets(filesystem))
	return targets
}

export function observeContentBindingTargets(
	filesystem: YjsFilesystem,
	onChange: (change: DurableStreamsContentBindingChange) => void,
): () => void {
	const files = getFilesMap(filesystem)
	const observer = (event: Y.YMapEvent<unknown>) => {
		const added: DurableStreamsContentBindingTarget[] = []
		const removed: ContentId[] = []

		for (const [contentId, change] of event.changes.keys.entries()) {
			if (change.action === 'delete') {
				removed.push(contentId)
				continue
			}

			const value = files.get(contentId)
			if (value === undefined) {
				continue
			}

			added.push({
				kind: 'content',
				contentId,
				value,
				bindingKey: contentId,
			})
		}

		if (added.length === 0 && removed.length === 0) {
			return
		}

		onChange({
			added: added.sort((left, right) => left.contentId.localeCompare(right.contentId)),
			removed: removed.sort((left, right) => left.localeCompare(right)),
		})
	}

	files.observe(observer)
	return () => {
		files.unobserve(observer)
	}
}

export function sortBindingDescriptors(
	descriptors: Iterable<DurableStreamsBindingDescriptor>,
): DurableStreamsBindingDescriptor[] {
	return Array.from(descriptors).sort(compareBindingDescriptors)
}

function compareBindingDescriptors(
	left: DurableStreamsBindingDescriptor,
	right: DurableStreamsBindingDescriptor,
): number {
	if (left.kind !== right.kind) {
		return bindingKindRank(left.kind) - bindingKindRank(right.kind)
	}

	if (left.kind === 'content' && right.kind === 'content') {
		if (left.contentId !== right.contentId) {
			return left.contentId.localeCompare(right.contentId)
		}
	}

	return left.channelId.localeCompare(right.channelId)
}

function bindingKindRank(kind: DurableStreamsBindingKind): number {
	switch (kind) {
		case 'root':
			return 0
		case 'awareness':
			return 1
		case 'content':
			return 2
	}
}

function getFilesMap(filesystem: YjsFilesystem): Y.Map<unknown> {
	return filesystem.doc.getMap<unknown>('files')
}
