import type * as Y from 'yjs'
import {
	buildTree,
	type CatalogState,
	createCatalogState,
	createFileInCatalog,
	deleteEntryInCatalog,
	getEntry,
	getPathForEntryId,
	listDirectoryEntries,
	lookupPath,
	mkdirInCatalog,
	normalizePath,
	renameInCatalog,
	updateFileMetadata,
} from './catalog'
import {
	type EntryDirent,
	type EntryMetadata,
	EntryNotFoundError,
	type EntryStat,
	type FileEntry,
	type FilesystemTreeNode,
	type LookupResult,
	NotDirectoryError,
	NotFileError,
} from './types'

/**
 * Store wrapper around the Yjs-backed catalog namespace.
 *
 * This class owns path normalization, lookup, listing, and namespace mutations,
 * while delegating the actual Yjs record layout to helpers in `catalog.ts`.
 */
export class CatalogStore {
	readonly doc: Y.Doc
	private readonly state: CatalogState

	/** Binds the store to the root Y.Doc and initializes catalog collections. */
	constructor(doc: Y.Doc) {
		this.doc = doc
		this.state = createCatalogState(doc)
	}

	/** Stable entry id for the root directory. */
	get rootEntryId(): string {
		return this.state.rootEntryId
	}

	/** Canonicalizes caller paths to the absolute format used internally. */
	normalizePath(path: string): string {
		return normalizePath(path)
	}

	/** Looks up a path in the namespace, returning undefined when it is absent. */
	lookup(path: string): LookupResult | undefined {
		return lookupPath(this.state, path)
	}

	/** Looks up a path and throws a typed error when it does not exist. */
	requireLookup(path: string): LookupResult {
		const result = this.lookup(path)
		if (!result) {
			throw new EntryNotFoundError(normalizePath(path))
		}

		return result
	}

	/** Looks up a path and asserts that it resolves to a directory entry. */
	requireDirectory(path: string): LookupResult & { entry: Extract<EntryMetadata, { type: 'directory' }> } {
		const result = this.requireLookup(path)
		if (result.entry.type !== 'directory') {
			throw new NotDirectoryError(result.path)
		}

		return result as LookupResult & { entry: Extract<EntryMetadata, { type: 'directory' }> }
	}

	/** Looks up a path and asserts that it resolves to a file entry. */
	requireFile(path: string): LookupResult & { entry: FileEntry } {
		const result = this.requireLookup(path)
		if (result.entry.type !== 'file') {
			throw new NotFileError(result.path)
		}

		return result as LookupResult & { entry: FileEntry }
	}

	/** Returns true when a path currently exists in the catalog. */
	exists(path: string): boolean {
		return this.lookup(path) !== undefined
	}

	/** Returns stat-style metadata for one path. */
	stat(path: string): EntryStat {
		const result = this.requireLookup(path)

		return {
			entryId: result.entryId,
			name: result.path === '/' ? '/' : result.entry.name,
			path: result.path,
			parentId: result.entry.parentId,
			type: result.entry.type,
			createdAt: result.entry.createdAt,
			modifiedAt: result.entry.modifiedAt,
			isDirectory: result.entry.type === 'directory',
			isFile: result.entry.type === 'file',
			contentId: result.entry.type === 'file' ? result.entry.contentId : undefined,
			size: result.entry.type === 'file' ? result.entry.size : undefined,
			encoding: result.entry.type === 'file' ? result.entry.encoding : undefined,
		}
	}

	/** Lists the immediate children of a directory path. */
	list(path = '/'): EntryDirent[] {
		const result = this.requireDirectory(path)
		return listDirectoryEntries(this.state, result.entryId)
	}

	/** Builds a recursive tree view rooted at a path. */
	tree(path = '/'): FilesystemTreeNode {
		return buildTree(this.state, path)
	}

	/**
	 * Subscribes to namespace changes.
	 *
	 * Updates are microtask-coalesced so a burst of Yjs mutations produces one
	 * callback per tick rather than one callback per low-level map event.
	 */
	subscribe(listener: () => void): () => void {
		let queued = false
		const notify = () => {
			if (queued) {
				return
			}

			queued = true
			queueMicrotask(() => {
				queued = false
				listener()
			})
		}

		this.state.catalog.observe(notify)
		this.state.entries.observeDeep(notify)
		this.state.children.observe(notify)
		this.state.pathIndex.observe(notify)

		return () => {
			this.state.catalog.unobserve(notify)
			this.state.entries.unobserveDeep(notify)
			this.state.children.unobserve(notify)
			this.state.pathIndex.unobserve(notify)
		}
	}

	/** Creates a directory entry at the requested path. */
	mkdir(path: string): string {
		return mkdirInCatalog(this.state, path)
	}

	/** Creates a file entry that points at an existing content record. */
	createFileEntry(path: string, contentId: string, size: number, encoding: 'text' | 'binary' = 'text'): string {
		return createFileInCatalog(this.state, path, contentId, size, encoding)
	}

	/** Renames or moves an existing namespace entry while preserving its identity. */
	rename(fromPath: string, toPath: string): string {
		return renameInCatalog(this.state, fromPath, toPath)
	}

	/** Deletes an entry from the namespace and returns the removed metadata. */
	delete(path: string): EntryMetadata {
		return deleteEntryInCatalog(this.state, path)
	}

	/** Updates file size metadata after content changes. */
	updateFileSize(entryId: string, size: number): void {
		updateFileMetadata(this.state, entryId, size)
	}

	/** Reads metadata directly by stable entry id. */
	getEntry(entryId: string): EntryMetadata | undefined {
		return getEntry(this.state, entryId)
	}

	/** Reconstructs the current path for a stable entry id. */
	getPath(entryId: string): string | undefined {
		return getPathForEntryId(this.state, entryId)
	}
}
