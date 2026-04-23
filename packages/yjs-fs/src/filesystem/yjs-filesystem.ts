import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { CatalogStore } from './catalog-store'
import { CommentStore } from './comment-store'
import { ContentStore } from './content-store'
import type { PresenceState, ResolvedPresenceSelection } from './presence'
import { PresenceStore } from './presence-store'
import {
	type CommentAnchor,
	type EditResult,
	type EntryDirent,
	type EntryStat,
	type FileComment,
	type LookupResult,
	NotBinaryFileError,
	NotTextFileError,
} from './types'

export type YjsFilesystemOptions = {
	doc?: Y.Doc
	awareness?: Awareness | null
}

export class YjsFilesystem {
	readonly doc: Y.Doc
	private readonly catalog: CatalogStore
	private readonly content: ContentStore
	private readonly comments: CommentStore
	private readonly presence: PresenceStore

	constructor(options: YjsFilesystemOptions = {}) {
		this.doc = options.doc ?? new Y.Doc()
		this.catalog = new CatalogStore(this.doc)
		this.content = new ContentStore(this.doc)
		this.comments = new CommentStore()
		this.presence = new PresenceStore(options.awareness ?? null)
	}

	get awareness(): Awareness | null {
		return this.presence.getAwareness()
	}

	lookup(path: string): LookupResult | undefined {
		return this.catalog.lookup(path)
	}

	exists(path: string): boolean {
		return this.catalog.exists(path)
	}

	stat(path: string): EntryStat {
		return this.catalog.stat(path)
	}

	list(path = '/'): EntryDirent[] {
		return this.catalog.list(path)
	}

	mkdir(path: string): string {
		return this.catalog.mkdir(path)
	}

	createFile(path: string, content = ''): string {
		const normalizedPath = this.catalog.normalizePath(path)
		const created = this.content.create(content)
		this.comments.initializeForContent(this.content, created.contentId, normalizedPath)
		return this.catalog.createFileEntry(normalizedPath, created.contentId, content.length, 'text')
	}

	createBinaryFile(path: string, content: Uint8Array = new Uint8Array(0)): string {
		const normalizedPath = this.catalog.normalizePath(path)
		const created = this.content.createBinary(content)
		return this.catalog.createFileEntry(normalizedPath, created.contentId, content.length, 'binary')
	}

	readFile(path: string): string {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		return this.content.read(entry.contentId, normalizedPath)
	}

	readBinaryFile(path: string): Uint8Array {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding !== 'binary') {
			throw new NotBinaryFileError(normalizedPath)
		}
		return this.content.readBinary(entry.contentId, normalizedPath)
	}

	writeFile(path: string, content: string): void {
		const { entry, entryId, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		this.content.write(entry.contentId, normalizedPath, content)
		this.catalog.updateFileSize(entryId, content.length)
	}

	writeBinaryFile(path: string, content: Uint8Array): void {
		const { entry, entryId, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding !== 'binary') {
			throw new NotBinaryFileError(normalizedPath)
		}
		this.content.writeBinary(entry.contentId, normalizedPath, content)
		this.catalog.updateFileSize(entryId, content.length)
	}

	editFile(path: string, oldText: string, newText: string): EditResult {
		const { entry, entryId, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		const result = this.content.edit(entry.contentId, normalizedPath, oldText, newText)
		this.catalog.updateFileSize(entryId, this.content.size(entry.contentId, normalizedPath))
		return result
	}

	addComment(path: string, anchor: CommentAnchor, body: string, author: string): string {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		return this.comments.addForContent(this.content, entry.contentId, normalizedPath, anchor, body, author)
	}

	getComments(path: string): FileComment[] {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		return this.comments.listForContent(this.content, entry.contentId, normalizedPath)
	}

	replyToComment(path: string, commentId: string, body: string, author: string): string {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		return this.comments.replyForContent(this.content, entry.contentId, normalizedPath, commentId, body, author)
	}

	resolveComment(path: string, commentId: string, author: string): void {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		this.comments.resolveForContent(this.content, entry.contentId, normalizedPath, commentId, author)
	}

	setAwareness(awareness: Awareness | null): void {
		this.presence.setAwareness(awareness)
	}

	getLocalPresence(): PresenceState | null {
		return this.presence.getLocalPresence()
	}

	setLocalPresence(presence: PresenceState | null): void {
		this.presence.setLocalPresence(presence)
	}

	updateLocalPresence(patch: Partial<PresenceState>): PresenceState | null {
		return this.presence.updateLocalPresence(patch)
	}

	setLocalSelection(path: string, anchorOffset: number, headOffset: number): void {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		this.presence.setLocalSelectionForContent(
			this.content,
			entry.contentId,
			normalizedPath,
			anchorOffset,
			headOffset,
		)
	}

	clearLocalSelection(): void {
		this.presence.clearLocalSelection()
	}

	getLocalSelection(path: string): ResolvedPresenceSelection | undefined {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		return this.presence.getLocalSelectionForContent(this.content, entry.contentId, normalizedPath)
	}

	rename(fromPath: string, toPath: string): void {
		this.catalog.rename(fromPath, toPath)
	}

	unlink(path: string): void {
		const deletedEntry = this.catalog.delete(path)

		if (deletedEntry.type === 'file') {
			this.content.delete(deletedEntry.contentId)
		}
	}
}
