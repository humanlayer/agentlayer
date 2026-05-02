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
	type FilesystemTreeNode,
	type LookupResult,
	NotBinaryFileError,
	NotTextFileError,
} from './types'

export type YjsFilesystemOptions = {
	/**
	 * Shared Yjs document backing the filesystem.
	 *
	 * For provider-backed docs, connect the provider and wait for initial sync
	 * before constructing `YjsFilesystem`. The constructor initializes missing
	 * catalog state for empty docs, so constructing it before remote hydration can
	 * create local catalog updates that race with persisted remote state.
	 */
	doc?: Y.Doc
	awareness?: Awareness | null
}

/**
 * High-level facade over the Yjs filesystem stores.
 *
 * `YjsFilesystem` keeps the public API path-oriented while internally splitting
 * responsibilities across the catalog, content, comment, and presence stores.
 *
 * When wrapping a Y.Doc that is backed by a remote provider, connect the
 * provider and wait for its initial sync before constructing this class. The
 * constructor initializes missing catalog state for empty docs; doing that before
 * remote hydration can create local catalog updates that race with persisted
 * remote state.
 *
 * @example
 * await provider.connect()
 * await waitForProviderSync(provider)
 * const fs = new YjsFilesystem({ doc: provider.doc, awareness })
 */
export class YjsFilesystem {
	readonly doc: Y.Doc
	private readonly catalog: CatalogStore
	private readonly content: ContentStore
	private readonly comments: CommentStore
	private readonly presence: PresenceStore

	/**
	 * Creates a filesystem around a shared root Y.Doc and optional awareness.
	 *
	 * For provider-backed docs, construct this only after `provider.connect()` has
	 * completed and the provider reports initial sync. Construction initializes
	 * missing catalog state for empty docs; doing that before remote hydration can
	 * race with persisted remote catalog state.
	 */
	constructor(options: YjsFilesystemOptions = {}) {
		this.doc = options.doc ?? new Y.Doc()
		this.catalog = new CatalogStore(this.doc)
		this.content = new ContentStore(this.doc)
		this.comments = new CommentStore()
		this.presence = new PresenceStore(options.awareness ?? null)
	}

	/** Exposes the currently configured awareness instance, if any. */
	get awareness(): Awareness | null {
		return this.presence.getAwareness()
	}

	/** Resolves a path into stable identity and entry metadata. */
	lookup(path: string): LookupResult | undefined {
		return this.catalog.lookup(path)
	}

	/** Returns true when a path currently exists in the namespace. */
	exists(path: string): boolean {
		return this.catalog.exists(path)
	}

	/** Returns stat-style metadata for a path. */
	stat(path: string): EntryStat {
		return this.catalog.stat(path)
	}

	/** Lists the immediate children of a directory path. */
	list(path = '/'): EntryDirent[] {
		return this.catalog.list(path)
	}

	/** Builds a recursive tree view rooted at a path. */
	tree(path = '/'): FilesystemTreeNode {
		return this.catalog.tree(path)
	}

	/** Subscribes to namespace-level changes anywhere in the catalog. */
	subscribe(listener: () => void): () => void {
		return this.catalog.subscribe(listener)
	}

	/**
	 * Subscribes to changes affecting a single path.
	 *
	 * This always watches the catalog so rename/delete events are visible, and it
	 * also watches the file's content record when the path resolves to a file.
	 */
	subscribePath(path: string, listener: () => void): () => void {
		const unsubscribeCatalog = this.catalog.subscribe(listener)

		try {
			const { entry, path: normalizedPath } = this.catalog.requireFile(path)
			const unsubscribeContent = this.content.subscribe(entry.contentId, normalizedPath, listener)
			return () => {
				unsubscribeContent()
				unsubscribeCatalog()
			}
		} catch {
			return unsubscribeCatalog
		}
	}

	/** Creates a directory entry in the namespace. */
	mkdir(path: string): string {
		return this.catalog.mkdir(path)
	}

	/**
	 * Creates a text file by first creating its content record and then its catalog
	 * entry, initializing comment storage on the same shared file record.
	 */
	createFile(path: string, content = ''): string {
		const normalizedPath = this.catalog.normalizePath(path)
		const created = this.content.create(content)
		this.comments.initializeForContent(this.content, created.contentId, normalizedPath)
		return this.catalog.createFileEntry(normalizedPath, created.contentId, content.length, 'text')
	}

	/** Creates a binary file backed by a binary content record. */
	createBinaryFile(path: string, content: Uint8Array = new Uint8Array(0)): string {
		const normalizedPath = this.catalog.normalizePath(path)
		const created = this.content.createBinary(content)
		return this.catalog.createFileEntry(normalizedPath, created.contentId, content.length, 'binary')
	}

	/** Reads the string contents of a text file. */
	readFile(path: string): string {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		return this.content.read(entry.contentId, normalizedPath)
	}

	/** Reads the bytes stored in a binary file. */
	readBinaryFile(path: string): Uint8Array {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding !== 'binary') {
			throw new NotBinaryFileError(normalizedPath)
		}
		return this.content.readBinary(entry.contentId, normalizedPath)
	}

	/** Returns the underlying collaborative `Y.Text` for a text file. */
	getYTextForFile(path: string): Y.Text {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		return this.content.getText(entry.contentId, normalizedPath)
	}

	/** Alias for `getYTextForFile` kept for caller ergonomics. */
	getYText(path: string): Y.Text {
		return this.getYTextForFile(path)
	}

	/** Replaces the entire contents of a text file and updates file metadata. */
	writeFile(path: string, content: string): void {
		const { entry, entryId, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		this.content.write(entry.contentId, normalizedPath, content)
		this.catalog.updateFileSize(entryId, content.length)
	}

	/** Replaces the entire contents of a binary file and updates file metadata. */
	writeBinaryFile(path: string, content: Uint8Array): void {
		const { entry, entryId, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding !== 'binary') {
			throw new NotBinaryFileError(normalizedPath)
		}
		this.content.writeBinary(entry.contentId, normalizedPath, content)
		this.catalog.updateFileSize(entryId, content.length)
	}

	/** Performs a unique substring replacement in a text file. */
	editFile(path: string, oldText: string, newText: string): EditResult {
		const { entry, entryId, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		const result = this.content.edit(entry.contentId, normalizedPath, oldText, newText)
		this.catalog.updateFileSize(entryId, this.content.size(entry.contentId, normalizedPath))
		return result
	}

	/** Adds an anchored comment to a text file. */
	addComment(path: string, anchor: CommentAnchor, body: string, author: string): string {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		return this.comments.addForContent(this.content, entry.contentId, normalizedPath, anchor, body, author)
	}

	/** Lists comments currently resolvable against a text file's contents. */
	getComments(path: string): FileComment[] {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		return this.comments.listForContent(this.content, entry.contentId, normalizedPath)
	}

	/** Adds a reply under an existing comment on a text file. */
	replyToComment(path: string, commentId: string, body: string, author: string): string {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		return this.comments.replyForContent(this.content, entry.contentId, normalizedPath, commentId, body, author)
	}

	/** Toggles the resolved state of a comment on a text file. */
	resolveComment(path: string, commentId: string, author: string): void {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		this.comments.resolveForContent(this.content, entry.contentId, normalizedPath, commentId, author)
	}

	/** Replaces the awareness instance used for presence features. */
	setAwareness(awareness: Awareness | null): void {
		this.presence.setAwareness(awareness)
	}

	/** Reads the local presence payload from awareness. */
	getLocalPresence(): PresenceState | null {
		return this.presence.getLocalPresence()
	}

	/** Replaces the local presence payload in awareness. */
	setLocalPresence(presence: PresenceState | null): void {
		this.presence.setLocalPresence(presence)
	}

	/** Applies a partial update to the local presence payload. */
	updateLocalPresence(patch: Partial<PresenceState>): PresenceState | null {
		return this.presence.updateLocalPresence(patch)
	}

	/** Stores a local text selection for a text file using relative positions. */
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

	/** Clears the local selection state from awareness. */
	clearLocalSelection(): void {
		this.presence.clearLocalSelection()
	}

	/** Resolves the current local selection for a text file. */
	getLocalSelection(path: string): ResolvedPresenceSelection | undefined {
		const { entry, path: normalizedPath } = this.catalog.requireFile(path)
		if (entry.encoding === 'binary') {
			throw new NotTextFileError(normalizedPath)
		}
		return this.presence.getLocalSelectionForContent(this.content, entry.contentId, normalizedPath)
	}

	/** Renames or moves a namespace entry while preserving stable identities. */
	rename(fromPath: string, toPath: string): void {
		this.catalog.rename(fromPath, toPath)
	}

	/** Deletes a namespace entry and removes file content when unlinking a file. */
	unlink(path: string): void {
		const deletedEntry = this.catalog.delete(path)

		if (deletedEntry.type === 'file') {
			this.content.delete(deletedEntry.contentId)
		}
	}
}
