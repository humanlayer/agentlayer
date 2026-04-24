/** Stable identifier for a catalog entry. */
export type EntryId = string

/** Stable identifier for the content record behind a file entry. */
export type ContentId = string

/** Namespace entry kinds supported by the filesystem catalog. */
export type EntryType = 'directory' | 'file'

type BaseEntry = {
	id: EntryId
	parentId: EntryId | null
	name: string
	createdAt: number
	modifiedAt: number
}

/** Metadata stored for a directory entry in the catalog. */
export type DirectoryEntry = BaseEntry & {
	type: 'directory'
}

/** Metadata stored for a file entry in the catalog. */
export type FileEntry = BaseEntry & {
	type: 'file'
	contentId: ContentId
	size: number
	encoding: 'text' | 'binary'
}

/** Union of all entry metadata records stored in the catalog. */
export type EntryMetadata = DirectoryEntry | FileEntry

/** Result returned when resolving a path into stable identity and metadata. */
export type LookupResult = {
	entryId: EntryId
	entry: EntryMetadata
	path: string
}

/** Lightweight listing entry used by `list()` results. */
export type EntryDirent = {
	entryId: EntryId
	name: string
	path: string
	type: EntryType
}

/** Recursive node used by `tree()` to describe a directory subtree. */
export type FilesystemTreeNode = {
	entryId: EntryId
	name: string
	path: string
	type: EntryType
	children?: FilesystemTreeNode[]
}

/** Stat-style metadata returned for a single path lookup. */
export type EntryStat = {
	entryId: EntryId
	name: string
	path: string
	parentId: EntryId | null
	type: EntryType
	createdAt: number
	modifiedAt: number
	isDirectory: boolean
	isFile: boolean
	contentId?: ContentId
	size?: number
	encoding?: 'text' | 'binary'
}

/** Details about a text replacement performed by `editFile()`. */
export type EditResult = {
	path: string
	editIndex: number
	editLine: number
	affectedLines: {
		start: number
		end: number
	}
}

/** Absolute text range used when creating a comment on a file. */
export type CommentAnchor = {
	index: number
	length: number
}

/** A reply stored under a top-level file comment. */
export type CommentReply = {
	id: string
	parentId: string
	author: string
	body: string
	createdAt: number
}

/** A comment resolved against the current contents of a text file. */
export type FileComment = {
	id: string
	author: string
	body: string
	createdAt: number
	anchorIndex: number
	anchorLength: number
	replies: CommentReply[]
	resolved: boolean
	resolvedAt?: number
	resolvedBy?: string
}

/** Base error type for filesystem API failures. */
export class YjsFsError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = new.target.name
		this.code = code
	}
}

/** Thrown when creating or renaming an entry onto an existing path. */
export class AlreadyExistsError extends YjsFsError {
	constructor(path: string) {
		super('ALREADY_EXISTS', `Path already exists: ${path}`)
	}
}

/** Thrown when a requested path cannot be resolved in the catalog. */
export class EntryNotFoundError extends YjsFsError {
	constructor(path: string) {
		super('ENTRY_NOT_FOUND', `Path not found: ${path}`)
	}
}

/** Thrown when a caller provides a path that cannot be normalized safely. */
export class InvalidPathError extends YjsFsError {
	constructor(path: string, reason?: string) {
		super('INVALID_PATH', reason ? `Invalid path ${path}: ${reason}` : `Invalid path: ${path}`)
	}
}

/** Thrown when an operation requires a directory but finds another entry type. */
export class NotDirectoryError extends YjsFsError {
	constructor(path: string) {
		super('NOT_DIRECTORY', `Path is not a directory: ${path}`)
	}
}

/** Thrown when an operation requires a file but finds another entry type. */
export class NotFileError extends YjsFsError {
	constructor(path: string) {
		super('NOT_FILE', `Path is not a file: ${path}`)
	}
}

/** Thrown when a binary-only API is used on a non-binary file. */
export class NotBinaryFileError extends YjsFsError {
	constructor(path: string) {
		super('NOT_BINARY_FILE', `Path is not a binary file: ${path}`)
	}
}

/** Thrown when a text-only API is used on a non-text file. */
export class NotTextFileError extends YjsFsError {
	constructor(path: string) {
		super('NOT_TEXT_FILE', `Path is not a text file: ${path}`)
	}
}

/** Thrown when attempting to delete a directory that still has children. */
export class DirectoryNotEmptyError extends YjsFsError {
	constructor(path: string) {
		super('DIRECTORY_NOT_EMPTY', `Directory is not empty: ${path}`)
	}
}

/** Thrown when mutating the root directory in a way the model does not allow. */
export class RootMutationError extends YjsFsError {
	constructor(action: string) {
		super('ROOT_MUTATION', `Cannot ${action} the root directory`)
	}
}
