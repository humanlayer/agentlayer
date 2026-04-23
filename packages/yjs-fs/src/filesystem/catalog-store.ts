import type * as Y from 'yjs'
import {
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
	type LookupResult,
	NotDirectoryError,
	NotFileError,
} from './types'

export class CatalogStore {
	readonly doc: Y.Doc
	private readonly state: CatalogState

	constructor(doc: Y.Doc) {
		this.doc = doc
		this.state = createCatalogState(doc)
	}

	get rootEntryId(): string {
		return this.state.rootEntryId
	}

	normalizePath(path: string): string {
		return normalizePath(path)
	}

	lookup(path: string): LookupResult | undefined {
		return lookupPath(this.state, path)
	}

	requireLookup(path: string): LookupResult {
		const result = this.lookup(path)
		if (!result) {
			throw new EntryNotFoundError(normalizePath(path))
		}

		return result
	}

	requireDirectory(path: string): LookupResult & { entry: Extract<EntryMetadata, { type: 'directory' }> } {
		const result = this.requireLookup(path)
		if (result.entry.type !== 'directory') {
			throw new NotDirectoryError(result.path)
		}

		return result as LookupResult & { entry: Extract<EntryMetadata, { type: 'directory' }> }
	}

	requireFile(path: string): LookupResult & { entry: FileEntry } {
		const result = this.requireLookup(path)
		if (result.entry.type !== 'file') {
			throw new NotFileError(result.path)
		}

		return result as LookupResult & { entry: FileEntry }
	}

	exists(path: string): boolean {
		return this.lookup(path) !== undefined
	}

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
		}
	}

	list(path = '/'): EntryDirent[] {
		const result = this.requireDirectory(path)
		return listDirectoryEntries(this.state, result.entryId)
	}

	mkdir(path: string): string {
		return mkdirInCatalog(this.state, path)
	}

	createFileEntry(path: string, contentId: string, size: number): string {
		return createFileInCatalog(this.state, path, contentId, size)
	}

	rename(fromPath: string, toPath: string): string {
		return renameInCatalog(this.state, fromPath, toPath)
	}

	delete(path: string): EntryMetadata {
		return deleteEntryInCatalog(this.state, path)
	}

	updateFileSize(entryId: string, size: number): void {
		updateFileMetadata(this.state, entryId, size)
	}

	getEntry(entryId: string): EntryMetadata | undefined {
		return getEntry(this.state, entryId)
	}

	getPath(entryId: string): string | undefined {
		return getPathForEntryId(this.state, entryId)
	}
}
