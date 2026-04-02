import { DurableStreamsProvider } from '@durable-streams/y-durable-streams'
import { nanoid } from 'nanoid'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
	createAbsolutePositionFromRelativePosition,
	createRelativePositionFromTypeIndex,
	decodeRelativePosition,
	encodeRelativePosition,
} from 'yjs'
import type {
	Comment,
	CommentReply,
	EditResult,
	Entry,
	FileMetadata,
	FileStat,
	GrepMatch,
	GrepOptions,
	StreamFSConnectOptions,
} from './types'
import { FileExistsError, FileNotFoundError } from './types'
import { matchGlob, normalizePath } from './utils'

function uint8ToBase64(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]!)
	}
	return btoa(binary)
}

function base64ToUint8(b64: string): Uint8Array {
	const binary = atob(b64)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}

export interface YjsStreamFSOptions {
	doc?: Y.Doc
}

export class YjsStreamFS {
	readonly doc: Y.Doc
	private readonly metadata: Y.Map<FileMetadata>
	private readonly files: Y.Map<Y.Doc>
	private subdocProviders = new Map<string, any>()
	private rootProvider: any = null
	private connectOptions: StreamFSConnectOptions | null = null
	private _awareness: Awareness | null = null

	/** Awareness instance if provided via connect(). Null if not connected with awareness. */
	get awareness(): Awareness | null {
		return this._awareness
	}

	constructor(options?: YjsStreamFSOptions) {
		this.doc = options?.doc ?? new Y.Doc()
		this.metadata = this.doc.getMap<FileMetadata>('metadata')
		this.files = this.doc.getMap<Y.Doc>('files')
	}

	// ─── File Operations ─────────────────────────────────────────────────

	createFile(path: string, content: string): void {
		const normalized = normalizePath(path)
		if (this.metadata.has(normalized)) {
			throw new FileExistsError(normalized)
		}

		const subdoc = new Y.Doc()
		const ytext = subdoc.getText('content')
		subdoc.getArray('comments') // initialize comments array

		// If connected, attach the subdoc provider BEFORE writing content so the
		// provider's 'update' listener is registered and captures the initial insert.
		if (this.connectOptions) {
			this.attachSubdocProvider(subdoc)
		}

		this.doc.transact(() => {
			ytext.insert(0, content)
			this.files.set(normalized, subdoc)
			this.metadata.set(normalized, {
				contentStreamId: subdoc.guid,
				size: content.length,
				createdAt: Date.now(),
				modifiedAt: Date.now(),
			})
		})
	}

	readFile(path: string): string {
		const normalized = normalizePath(path)
		const subdoc = this.files.get(normalized)
		if (!subdoc) throw new FileNotFoundError(normalized)
		return subdoc.getText('content').toString()
	}

	editFile(path: string, oldString: string, newString: string): EditResult {
		const normalized = normalizePath(path)
		const subdoc = this.files.get(normalized)
		if (!subdoc) throw new FileNotFoundError(normalized)

		const ytext = subdoc.getText('content')
		const content = ytext.toString()
		const firstIdx = content.indexOf(oldString)

		if (firstIdx === -1) {
			throw new Error(`No match found for oldString in ${normalized}`)
		}

		// Check uniqueness
		const secondIdx = content.indexOf(oldString, firstIdx + 1)
		if (secondIdx !== -1) {
			throw new Error(
				'Found multiple matches for oldString. Provide more surrounding context to make the match unique.',
			)
		}

		// Calculate line positions (1-indexed)
		const startLine = content.substring(0, firstIdx).split('\n').length
		const endLine = startLine + newString.split('\n').length - 1

		subdoc.transact(() => {
			ytext.delete(firstIdx, oldString.length)
			ytext.insert(firstIdx, newString)
		})

		// Update metadata
		const meta = this.metadata.get(normalized)
		if (meta) {
			this.metadata.set(normalized, {
				...meta,
				size: ytext.toString().length,
				modifiedAt: Date.now(),
			})
		}

		return {
			path: normalized,
			editIndex: firstIdx,
			editLine: startLine,
			affectedLines: { start: startLine, end: endLine },
		}
	}

	deleteFile(path: string): void {
		const normalized = normalizePath(path)
		if (!this.metadata.has(normalized)) {
			throw new FileNotFoundError(normalized)
		}

		this.doc.transact(() => {
			const subdoc = this.files.get(normalized)
			if (subdoc) subdoc.destroy()
			this.files.delete(normalized)
			this.metadata.delete(normalized)
		})
	}

	// ─── Query Operations ────────────────────────────────────────────────

	list(path: string): Entry[] {
		const normalized = normalizePath(path)
		const prefix = normalized === '/' ? '/' : `${normalized}/`
		const entries = new Map<string, Entry>()

		for (const [filePath] of this.metadata) {
			if (filePath === normalized) continue
			if (!filePath.startsWith(prefix)) continue

			// Get the immediate child name
			const relative = filePath.slice(prefix.length)
			const slashIdx = relative.indexOf('/')
			if (slashIdx === -1) {
				// Direct child file
				entries.set(relative, { name: relative, type: 'file' })
			} else {
				// Nested — show as directory
				const dirName = relative.slice(0, slashIdx)
				entries.set(dirName, { name: dirName, type: 'directory' })
			}
		}

		return Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name))
	}

	exists(path: string): boolean {
		return this.metadata.has(normalizePath(path))
	}

	stat(path: string): FileStat {
		const normalized = normalizePath(path)
		const meta = this.metadata.get(normalized)
		if (!meta) throw new FileNotFoundError(normalized)
		return {
			size: meta.size,
			createdAt: meta.createdAt,
			modifiedAt: meta.modifiedAt,
		}
	}

	glob(pattern: string): string[] {
		const paths: string[] = []
		for (const [filePath] of this.metadata) {
			if (matchGlob(filePath, pattern)) {
				paths.push(filePath)
			}
		}
		return paths.sort()
	}

	grep(pattern: string | RegExp, opts?: GrepOptions): GrepMatch[] {
		const regex = typeof pattern === 'string' ? new RegExp(pattern, 'g') : pattern
		const matches: GrepMatch[] = []

		for (const [filePath, subdoc] of this.files) {
			// Apply include filter
			if (opts?.include && !matchGlob(filePath, opts.include)) continue

			const content = subdoc.getText('content').toString()
			const lines = content.split('\n')

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!
				// Reset regex lastIndex for each line
				regex.lastIndex = 0
				if (regex.test(line)) {
					matches.push({ file: filePath, line: i + 1, content: line })
				}
			}
		}

		return matches
	}

	// ─── Comment Operations ──────────────────────────────────────────────

	addComment(path: string, anchor: { index: number; length: number }, body: string, author: string): string {
		const normalized = normalizePath(path)
		const subdoc = this.files.get(normalized)
		if (!subdoc) throw new FileNotFoundError(normalized)

		const ytext = subdoc.getText('content')
		const comments = subdoc.getArray<Y.Map<string | number>>('comments')
		const id = nanoid(8)

		const anchorStart = createRelativePositionFromTypeIndex(ytext, anchor.index)
		const anchorEnd = createRelativePositionFromTypeIndex(ytext, anchor.index + anchor.length)

		// Store as Y.Map so each field is a proper CRDT type that syncs.
		// Uint8Array positions are base64-encoded to survive sync round-trips.
		// Y.Array for replies requires a broader value type than string | number.
		const ymap = new Y.Map<string | number | Y.Array<any>>()
		ymap.set('id', id)
		ymap.set('author', author)
		ymap.set('body', body)
		ymap.set('createdAt', Date.now())
		ymap.set('anchorStart', uint8ToBase64(encodeRelativePosition(anchorStart)))
		ymap.set('anchorEnd', uint8ToBase64(encodeRelativePosition(anchorEnd)))
		ymap.set('replies', new Y.Array())

		comments.push([ymap as unknown as Y.Map<string | number>])

		return id
	}

	getComments(path: string): Comment[] {
		const normalized = normalizePath(path)
		const subdoc = this.files.get(normalized)
		if (!subdoc) throw new FileNotFoundError(normalized)

		const comments = subdoc.getArray<Y.Map<string | number>>('comments')
		const result: Comment[] = []

		for (let i = 0; i < comments.length; i++) {
			const item = comments.get(i)
			// Skip legacy plain-object entries that predate the Y.Map format
			if (typeof item.get !== 'function') continue

			const ymap = item as Y.Map<string | number>
			try {
				const startBytes = base64ToUint8(ymap.get('anchorStart') as string)
				const endBytes = base64ToUint8(ymap.get('anchorEnd') as string)
				const startRel = decodeRelativePosition(startBytes)
				const endRel = decodeRelativePosition(endBytes)
				const startAbs = createAbsolutePositionFromRelativePosition(startRel, subdoc)
				const endAbs = createAbsolutePositionFromRelativePosition(endRel, subdoc)

				if (startAbs && endAbs) {
					const commentId = ymap.get('id') as string
					const repliesArray = ymap.get('replies') as Y.Array<Y.Map<string | number>> | undefined
					const replies: CommentReply[] = []
					if (repliesArray instanceof Y.Array) {
						for (let j = 0; j < repliesArray.length; j++) {
							const r = repliesArray.get(j)
							if (typeof r.get === 'function') {
								replies.push({
									id: r.get('id') as string,
									parentId: (r.get('parentId') as string | undefined) ?? commentId,
									author: r.get('author') as string,
									body: r.get('body') as string,
									createdAt: r.get('createdAt') as number,
								})
							}
						}
					}
					const resolved = (ymap.get('resolved') as boolean | undefined) ?? false
					result.push({
						id: commentId,
						author: ymap.get('author') as string,
						body: ymap.get('body') as string,
						createdAt: ymap.get('createdAt') as number,
						anchorIndex: startAbs.index,
						anchorLength: endAbs.index - startAbs.index,
						replies,
						resolved,
						resolvedAt: resolved ? (ymap.get('resolvedAt') as number | undefined) : undefined,
						resolvedBy: resolved ? (ymap.get('resolvedBy') as string | undefined) : undefined,
					})
				}
			} catch {
				// Skip malformed entries
			}
		}

		return result
	}

	deleteComment(path: string, commentId: string): void {
		const normalized = normalizePath(path)
		const subdoc = this.files.get(normalized)
		if (!subdoc) throw new FileNotFoundError(normalized)

		const comments = subdoc.getArray<Y.Map<string | number>>('comments')
		for (let i = 0; i < comments.length; i++) {
			const item = comments.get(i)
			if (typeof item.get !== 'function') continue
			if (item.get('id') === commentId) {
				comments.delete(i, 1)
				return
			}
		}
	}

	resolveComment(path: string, commentId: string, author: string): void {
		const normalized = normalizePath(path)
		const subdoc = this.files.get(normalized)
		if (!subdoc) throw new FileNotFoundError(normalized)

		const comments = subdoc.getArray<Y.Map<any>>('comments')
		for (let i = 0; i < comments.length; i++) {
			const item = comments.get(i)
			if (typeof item.get !== 'function') continue
			if (item.get('id') === commentId) {
				const isResolved = item.get('resolved') as boolean | undefined
				if (isResolved) {
					// Unresolve
					item.set('resolved', false)
					item.delete('resolvedAt')
					item.delete('resolvedBy')
				} else {
					item.set('resolved', true)
					item.set('resolvedAt', Date.now())
					item.set('resolvedBy', author)
				}
				return
			}
		}
		throw new Error(`Comment not found: ${commentId}`)
	}

	replyToComment(path: string, commentId: string, body: string, author: string): string {
		const normalized = normalizePath(path)
		const subdoc = this.files.get(normalized)
		if (!subdoc) throw new FileNotFoundError(normalized)

		const comments = subdoc.getArray<Y.Map<any>>('comments')
		for (let i = 0; i < comments.length; i++) {
			const item = comments.get(i)
			if (typeof item.get !== 'function') continue
			if (item.get('id') === commentId) {
				let repliesArray = item.get('replies') as Y.Array<Y.Map<string | number>> | undefined
				if (!(repliesArray instanceof Y.Array)) {
					repliesArray = new Y.Array()
					item.set('replies', repliesArray)
				}
				const id = nanoid(8)
				const replyMap = new Y.Map<string | number>()
				replyMap.set('id', id)
				replyMap.set('parentId', commentId)
				replyMap.set('author', author)
				replyMap.set('body', body)
				replyMap.set('createdAt', Date.now())
				repliesArray.push([replyMap])
				return id
			}
		}
		throw new Error(`Comment not found: ${commentId}`)
	}

	// ─── Sync ───────────────────────────────────────────────────────────

	private attachSubdocProvider(subdoc: Y.Doc): void {
		if (!this.connectOptions) return
		if (this.subdocProviders.has(subdoc.guid)) return
		const { baseUrl, prefix, headers } = this.connectOptions
		const provider = new DurableStreamsProvider({
			doc: subdoc,
			documentStream: {
				url: `${baseUrl}/v1/stream/${prefix}/_file/${subdoc.guid}`,
				headers,
			},
		})
		this.subdocProviders.set(subdoc.guid, provider)
	}

	async connect(options: StreamFSConnectOptions): Promise<void> {
		this.connectOptions = options
		const { baseUrl, prefix, headers } = options
		this._awareness = options.awareness ?? null

		// Root doc provider
		this.rootProvider = new DurableStreamsProvider({
			doc: this.doc,
			documentStream: {
				url: `${baseUrl}/v1/stream/${prefix}/_root`,
				headers,
			},
			...(options.awareness && {
				awarenessStream: {
					url: `${baseUrl}/v1/stream/${prefix}/_awareness`,
					headers,
					protocol: options.awareness,
				},
			}),
		})

		// Wait for root doc to sync (only resolve once synced is true)
		await new Promise<void>((resolve) => {
			if (this.rootProvider.synced) return resolve()
			this.rootProvider.on('synced', (isSynced: boolean) => {
				if (isSynced) resolve()
			})
		})

		// Subdoc lifecycle: create/destroy providers per subdoc
		// - 'added': subdoc reference received from remote, call load() to trigger sync
		// - 'loaded': subdoc is being loaded (either locally created or after load() call)
		this.doc.on(
			'subdocs',
			({ added, loaded, removed }: { added: Set<Y.Doc>; loaded: Set<Y.Doc>; removed: Set<Y.Doc> }) => {
				// For remotely-received subdoc references, trigger loading so we get a provider
				for (const subdoc of added) {
					if (!subdoc.shouldLoad) {
						subdoc.load()
					}
				}
				// Create provider when subdoc is loaded (locally created or after load())
				for (const subdoc of loaded) {
					this.attachSubdocProvider(subdoc)
				}
				for (const subdoc of removed) {
					const provider = this.subdocProviders.get(subdoc.guid)
					if (provider) {
						provider.destroy()
						this.subdocProviders.delete(subdoc.guid)
					}
				}
			},
		)

		// Attach providers for any subdocs that are already loaded (local, pre-connect files)
		for (const subdoc of this.doc.subdocs) {
			this.attachSubdocProvider(subdoc)
		}
	}

	disconnect(): void {
		for (const [, provider] of this.subdocProviders) {
			provider.destroy()
		}
		this.subdocProviders.clear()
		this.rootProvider?.destroy()
		this.rootProvider = null
		this.connectOptions = null
		this._awareness = null
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────

	close(): void {
		for (const [, provider] of this.subdocProviders) {
			provider.destroy?.()
		}
		this.subdocProviders.clear()
		this.rootProvider?.destroy?.()
		this.rootProvider = null
		this.doc.destroy()
	}
}
