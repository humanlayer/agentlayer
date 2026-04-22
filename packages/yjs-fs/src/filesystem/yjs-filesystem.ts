import * as Y from 'yjs'
import {
	type CatalogState,
	createCatalogState,
	createFileInCatalog,
	deleteEntryInCatalog,
	listDirectoryEntries,
	lookupPath,
	mkdirInCatalog,
	normalizePath,
	renameInCatalog,
	updateFileMetadata,
} from '../catalog'
import {
	addCommentRecord,
	getCommentRecords,
	initializeComments,
	replyToCommentRecord,
	resolveCommentRecord,
} from '../comments'
import {
	type CommentAnchor,
	type EditResult,
	type EntryDirent,
	EntryNotFoundError,
	type EntryStat,
	type FileComment,
	type LookupResult,
	NotDirectoryError,
	NotFileError,
} from '../types'

export type YjsFilesystemOptions = {
	doc?: Y.Doc
}

export class YjsFilesystem {
	readonly doc: Y.Doc
	private readonly catalog: CatalogState
	private readonly contentDocs: Y.Map<Y.Doc>

	constructor(options: YjsFilesystemOptions = {}) {
		this.doc = options.doc ?? new Y.Doc()
		this.catalog = createCatalogState(this.doc)
		this.contentDocs = this.doc.getMap<Y.Doc>('contentDocs')
	}

	lookup(path: string): LookupResult | undefined {
		return lookupPath(this.catalog, path)
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
		const result = this.requireLookup(path)

		if (result.entry.type !== 'directory') {
			throw new NotDirectoryError(result.path)
		}

		return listDirectoryEntries(this.catalog, result.entryId)
	}

	mkdir(path: string): string {
		return mkdirInCatalog(this.catalog, path)
	}

	createFile(path: string, content = ''): string {
		const normalizedPath = normalizePath(path)
		const contentDoc = new Y.Doc({ guid: crypto.randomUUID() })
		const ytext = contentDoc.getText('content')

		if (content.length > 0) {
			ytext.insert(0, content)
		}
		initializeComments(contentDoc)

		const entryId = createFileInCatalog(this.catalog, normalizedPath, contentDoc.guid, content.length)
		this.contentDocs.set(contentDoc.guid, contentDoc)
		return entryId
	}

	readFile(path: string): string {
		const { entry, path: normalizedPath } = this.requireFileLookup(path)
		return this.requireContentDoc(entry.contentId, normalizedPath).getText('content').toString()
	}

	writeFile(path: string, content: string): void {
		const { entry, entryId, path: normalizedPath } = this.requireFileLookup(path)
		const ytext = this.requireContentDoc(entry.contentId, normalizedPath).getText('content')

		this.doc.transact(() => {
			ytext.delete(0, ytext.length)
			if (content.length > 0) {
				ytext.insert(0, content)
			}
			updateFileMetadata(this.catalog, entryId, content.length)
		})
	}

	editFile(path: string, oldText: string, newText: string): EditResult {
		const { entry, entryId, path: normalizedPath } = this.requireFileLookup(path)
		const ytext = this.requireContentDoc(entry.contentId, normalizedPath).getText('content')
		const content = ytext.toString()
		const firstIndex = content.indexOf(oldText)

		if (firstIndex === -1) {
			throw new Error(`No match found for oldText in ${normalizedPath}`)
		}

		if (content.indexOf(oldText, firstIndex + 1) !== -1) {
			throw new Error(
				'Found multiple matches for oldText. Provide more surrounding context to make the match unique.',
			)
		}

		const editLine = content.slice(0, firstIndex).split('\n').length
		const affectedLines = {
			start: editLine,
			end: editLine + newText.split('\n').length - 1,
		}

		this.doc.transact(() => {
			ytext.delete(firstIndex, oldText.length)
			ytext.insert(firstIndex, newText)
			updateFileMetadata(this.catalog, entryId, ytext.toString().length)
		})

		return {
			path: normalizedPath,
			editIndex: firstIndex,
			editLine,
			affectedLines,
		}
	}

	addComment(path: string, anchor: CommentAnchor, body: string, author: string): string {
		const { entry, path: normalizedPath } = this.requireFileLookup(path)
		return addCommentRecord(this.requireContentDoc(entry.contentId, normalizedPath), anchor, body, author)
	}

	getComments(path: string): FileComment[] {
		const { entry, path: normalizedPath } = this.requireFileLookup(path)
		return getCommentRecords(this.requireContentDoc(entry.contentId, normalizedPath))
	}

	replyToComment(path: string, commentId: string, body: string, author: string): string {
		const { entry, path: normalizedPath } = this.requireFileLookup(path)
		return replyToCommentRecord(this.requireContentDoc(entry.contentId, normalizedPath), commentId, body, author)
	}

	resolveComment(path: string, commentId: string, author: string): void {
		const { entry, path: normalizedPath } = this.requireFileLookup(path)
		resolveCommentRecord(this.requireContentDoc(entry.contentId, normalizedPath), commentId, author)
	}

	rename(fromPath: string, toPath: string): void {
		renameInCatalog(this.catalog, fromPath, toPath)
	}

	unlink(path: string): void {
		const deletedEntry = deleteEntryInCatalog(this.catalog, path)

		if (deletedEntry.type === 'file') {
			this.contentDocs.delete(deletedEntry.contentId)
		}
	}

	private requireLookup(path: string): LookupResult {
		const result = this.lookup(path)

		if (!result) {
			throw new EntryNotFoundError(normalizePath(path))
		}

		return result
	}

	private requireFileLookup(
		path: string,
	): LookupResult & { entry: Extract<LookupResult['entry'], { type: 'file' }> } {
		const result = this.requireLookup(path)

		if (result.entry.type !== 'file') {
			throw new NotFileError(result.path)
		}

		return result as LookupResult & { entry: Extract<LookupResult['entry'], { type: 'file' }> }
	}

	private requireContentDoc(contentId: string, path: string): Y.Doc {
		const contentDoc = this.contentDocs.get(contentId)

		if (!contentDoc) {
			throw new EntryNotFoundError(path)
		}

		return contentDoc
	}
}
