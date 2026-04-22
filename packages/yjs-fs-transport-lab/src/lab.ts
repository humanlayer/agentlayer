import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
	YjsFilesystem,
	type FileComment,
	type PresenceState,
	type EntryStat,
} from '@humanlayer/yjs-fs'
import type {
	DurableStreamsBindingDescriptor,
	DurableStreamsClient,
	DurableStreamsClientSession,
	DurableStreamsTransportMode,
} from '@humanlayer/yjs-fs/durable-streams/client'
import {
	createInMemoryPerDocumentTransport,
	createPerDocumentDurableStreamsClient,
	type PerDocumentMessage,
	type PerDocumentTransport,
} from '@humanlayer/yjs-fs/durable-streams/per-doc-client'
import {
	createInMemorySingleStreamTransport,
	createSingleStreamDurableStreamsClient,
	type SingleStreamMessage,
	type SingleStreamTransport,
} from '@humanlayer/yjs-fs/durable-streams/single-stream-client'

type ReplicaId = 'A' | 'B'

type Replica = {
	id: ReplicaId
	doc: Y.Doc
	awareness: Awareness
	filesystem: YjsFilesystem
	session: DurableStreamsClientSession | null
}

export type TransportLogEntry = {
	id: number
	channelId: string
	bindingKind: DurableStreamsBindingDescriptor['kind']
	contentId?: string
	timestamp: string
}

export type PresencePeer = {
	clientId: number
	userId?: string
	name?: string
	activePath?: string
	hasSelection: boolean
}

export type ReplicaSnapshot = {
	connected: boolean
	bindingCount: number
	contentBindingCount: number
	channelIds: string[]
	approximateHttpOneStreams: number
	selectedText: string
	selectedStat?: EntryStat
	comments: FileComment[]
	presencePeers: PresencePeer[]
}

export type LabSnapshot = {
	mode: DurableStreamsTransportMode
	selectedPath: string | null
	files: string[]
	replicaA: ReplicaSnapshot
	replicaB: ReplicaSnapshot
	logEntries: TransportLogEntry[]
	logCount: number
	notes: string[]
}

export class TransportLabController {
	readonly mode: DurableStreamsTransportMode

	private readonly client: DurableStreamsClient
	private readonly replicaA = createReplica('A')
	private readonly replicaB = createReplica('B')
	private readonly logEntries: TransportLogEntry[] = []
	private nextDocumentNumber = 1
	private nextLogId = 1
	private selectedPath: string | null = null

	constructor(mode: DurableStreamsTransportMode) {
		this.mode = mode
		this.client = createClient(mode, (entry) => {
			this.logEntries.unshift(entry)
			if (this.logEntries.length > 40) {
				this.logEntries.length = 40
			}
		})
		this.connectReplica('A')
	}

	connectReplica(id: ReplicaId): void {
		const replica = this.replica(id)
		if (replica.session) {
			return
		}

		replica.session = requireSynchronousSession(this.client.connect({ filesystem: replica.filesystem }))
	}

	disconnectReplica(id: ReplicaId): void {
		const replica = this.replica(id)
		replica.session?.disconnect()
		replica.session = null
	}

	seedDocuments(count: number): void {
		this.ensureWorkspace()

		for (let index = 0; index < count; index += 1) {
			const path = `/workspace/doc-${String(this.nextDocumentNumber).padStart(2, '0')}.md`
			const heading = `# Doc ${this.nextDocumentNumber}`
			const body = [
				heading,
				'',
				`Topology: ${this.mode}`,
				'Collaborative notes live here.',
			].join('\n')
			this.replicaA.filesystem.createFile(path, body)
			this.selectedPath ??= path
			this.nextDocumentNumber += 1
		}
	}

	selectPath(path: string): void {
		this.selectedPath = path
	}

	applyText(replicaId: ReplicaId, text: string): void {
		const path = this.selectedPath
		if (!path) {
			return
		}

		const replica = this.replica(replicaId)
		if (!replica.filesystem.exists(path)) {
			return
		}

		replica.filesystem.writeFile(path, text)
	}

	renameSelected(): void {
		const path = this.selectedPath
		if (!path || !this.replicaA.filesystem.exists(path)) {
			return
		}

		const nextPath = renamePath(path)
		this.replicaA.filesystem.rename(path, nextPath)
		this.selectedPath = nextPath
	}

	deleteSelected(): void {
		const path = this.selectedPath
		if (!path || !this.replicaA.filesystem.exists(path)) {
			return
		}

		this.replicaA.filesystem.unlink(path)
		const remaining = this.listWorkspaceFiles()
		this.selectedPath = remaining[0] ?? null
	}

	addCommentFromReplicaA(): void {
		const path = this.selectedPath
		if (!path || !this.replicaA.filesystem.exists(path)) {
			return
		}

		const content = this.replicaA.filesystem.readFile(path)
		if (content.length === 0) {
			return
		}

		this.replicaA.filesystem.addComment(
			path,
			{ index: 0, length: Math.min(12, content.length) },
			`Inspect ${path} over ${this.mode}`,
			'agent-a',
		)
	}

	resolveFirstCommentFromReplicaB(): void {
		const path = this.selectedPath
		if (!path || !this.replicaB.filesystem.exists(path)) {
			return
		}

		const firstComment = this.replicaB.filesystem.getComments(path)[0]
		if (!firstComment) {
			return
		}

		this.replicaB.filesystem.resolveComment(path, firstComment.id, 'agent-b')
	}

	setPresence(replicaId: ReplicaId): void {
		const path = this.selectedPath
		if (!path) {
			return
		}

		const replica = this.replica(replicaId)
		if (!replica.filesystem.exists(path)) {
			return
		}

		const content = replica.filesystem.readFile(path)
		const index = Math.min(10, content.length)
		const presence: PresenceState = {
			user: {
				id: replicaId === 'A' ? 'agent-a' : 'agent-b',
				name: replicaId === 'A' ? 'Replica A' : 'Replica B',
			},
			activePath: path,
			cursor: {
				path,
				index,
				length: Math.min(6, Math.max(content.length - index, 0)),
			},
		}

		replica.filesystem.setLocalPresence(presence)
		replica.filesystem.setLocalSelection(path, index, Math.min(content.length, index + 6))
	}

	clearLogs(): void {
		this.logEntries.length = 0
	}

	getSnapshot(): LabSnapshot {
		const files = this.listWorkspaceFiles()
		if (!this.selectedPath && files[0]) {
			this.selectedPath = files[0]
		}

		return {
			mode: this.mode,
			selectedPath: this.selectedPath,
			files,
			replicaA: createReplicaSnapshot(this.replicaA, this.selectedPath),
			replicaB: createReplicaSnapshot(this.replicaB, this.selectedPath),
			logEntries: [...this.logEntries],
			logCount: this.logEntries.length,
			notes: topologyNotes(this.mode),
		}
	}

	private ensureWorkspace(): void {
		if (!this.replicaA.filesystem.exists('/workspace')) {
			this.replicaA.filesystem.mkdir('/workspace')
		}
	}

	private listWorkspaceFiles(): string[] {
		if (!this.replicaA.filesystem.exists('/workspace')) {
			return []
		}

		return this.replicaA.filesystem
			.list('/workspace')
			.filter((entry) => entry.type === 'file')
			.map((entry) => entry.path)
			.sort((left, right) => left.localeCompare(right))
	}

	private replica(id: ReplicaId): Replica {
		return id === 'A' ? this.replicaA : this.replicaB
	}
}

export function createTransportLabController(mode: DurableStreamsTransportMode): TransportLabController {
	return new TransportLabController(mode)
}

function createReplica(id: ReplicaId): Replica {
	const doc = new Y.Doc()
	const awareness = new Awareness(doc)
	const filesystem = new YjsFilesystem({ doc, awareness })

	return {
		id,
		doc,
		awareness,
		filesystem,
		session: null,
	}
}

function createClient(
	mode: DurableStreamsTransportMode,
	onLogEntry: (entry: TransportLogEntry) => void,
): DurableStreamsClient {
	if (mode === 'single-stream') {
		const transport = createInMemorySingleStreamTransport()
		const instrumented: SingleStreamTransport = {
			subscribe(listener) {
				return transport.subscribe(listener)
			},
			publish(message: SingleStreamMessage) {
				onLogEntry(createLogEntry(message.channelId, message.binding.kind, bindingContentId(message.binding)))
				transport.publish(message)
			},
		}

		return createSingleStreamDurableStreamsClient({ transport: instrumented })
	}

	const transport = createInMemoryPerDocumentTransport()
	const instrumented: PerDocumentTransport = {
		subscribe(channelId, listener) {
			return transport.subscribe(channelId, listener)
		},
		publish(message: PerDocumentMessage) {
			onLogEntry(createLogEntry(message.channelId, message.binding.kind, bindingContentId(message.binding)))
			transport.publish(message)
		},
	}

	return createPerDocumentDurableStreamsClient({ transport: instrumented })
}

function createReplicaSnapshot(replica: Replica, selectedPath: string | null): ReplicaSnapshot {
	const bindings = replica.session?.describeBindings() ?? []
	const channelIds = [...new Set(bindings.map((binding) => binding.channelId))].sort((left, right) => left.localeCompare(right))

	return {
		connected: replica.session !== null,
		bindingCount: bindings.length,
		contentBindingCount: bindings.filter((binding) => binding.kind === 'content').length,
		channelIds,
		approximateHttpOneStreams: channelIds.length,
		selectedText: safeReadFile(replica.filesystem, selectedPath),
		selectedStat: safeStat(replica.filesystem, selectedPath),
		comments: safeComments(replica.filesystem, selectedPath),
		presencePeers: summarizePresence(replica.awareness),
	}
}

function summarizePresence(awareness: Awareness): PresencePeer[] {
	return Array.from(awareness.getStates().entries())
		.map(([clientId, state]) => {
			const presence = isRecord(state?.presence) ? state.presence : undefined
			const user = isRecord(presence?.user) ? presence.user : undefined
			return {
				clientId,
				userId: typeof user?.id === 'string' ? user.id : undefined,
				name: typeof user?.name === 'string' ? user.name : undefined,
				activePath: typeof presence?.activePath === 'string' ? presence.activePath : undefined,
				hasSelection: Boolean(state?.selection),
			}
		})
		.sort((left, right) => left.clientId - right.clientId)
}

function requireSynchronousSession(
	session: DurableStreamsClientSession | Promise<DurableStreamsClientSession>,
): DurableStreamsClientSession {
	if (session instanceof Promise) {
		throw new Error('Transport lab expects synchronous in-memory transport sessions')
	}

	return session
}

function bindingContentId(
	binding: { kind: 'root' } | { kind: 'awareness' } | { kind: 'content'; contentId: string },
): string | undefined {
	return binding.kind === 'content' ? binding.contentId : undefined
}

function safeReadFile(filesystem: YjsFilesystem, path: string | null): string {
	if (!path || !filesystem.exists(path)) {
		return ''
	}

	return filesystem.readFile(path)
}

function safeStat(filesystem: YjsFilesystem, path: string | null): EntryStat | undefined {
	if (!path || !filesystem.exists(path)) {
		return undefined
	}

	return filesystem.stat(path)
}

function safeComments(filesystem: YjsFilesystem, path: string | null): FileComment[] {
	if (!path || !filesystem.exists(path)) {
		return []
	}

	return filesystem.getComments(path)
}

function createLogEntry(
	channelId: string,
	bindingKind: DurableStreamsBindingDescriptor['kind'],
	contentId?: string,
): TransportLogEntry {
	return {
		id: logSequence(),
		channelId,
		bindingKind,
		contentId,
		timestamp: new Date().toLocaleTimeString(),
	}
}

let currentLogSequence = 1

function logSequence(): number {
	const value = currentLogSequence
	currentLogSequence += 1
	return value
}

function topologyNotes(mode: DurableStreamsTransportMode): string[] {
	if (mode === 'single-stream') {
		return [
			'Root and content-doc updates share one replayed channel.',
			'Awareness gets its own channel.',
			'Browser channel count stays flat as file count grows.',
		]
	}

	return [
		'Root, awareness, and each content doc use separate channels.',
		'Channel count grows with the number of loaded file docs.',
		'This mirrors the current subdoc/provider shape more directly.',
	]
}

function renamePath(path: string): string {
	const dotIndex = path.lastIndexOf('.')
	if (dotIndex <= path.lastIndexOf('/')) {
		return `${path}-renamed`
	}

	return `${path.slice(0, dotIndex)}-renamed${path.slice(dotIndex)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}
