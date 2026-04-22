export type EntryId = string
export type ContentId = string

export type EntryType = 'directory' | 'file'

type BaseEntry = {
	id: EntryId
	parentId: EntryId | null
	name: string
	createdAt: number
	modifiedAt: number
}

export type DirectoryEntry = BaseEntry & {
	type: 'directory'
}

export type FileEntry = BaseEntry & {
	type: 'file'
	contentId: ContentId
	size: number
}

export type EntryMetadata = DirectoryEntry | FileEntry

export type LookupResult = {
	entryId: EntryId
	entry: EntryMetadata
	path: string
}

export type EntryDirent = {
	entryId: EntryId
	name: string
	path: string
	type: EntryType
}

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
}

export type EditResult = {
	path: string
	editIndex: number
	editLine: number
	affectedLines: {
		start: number
		end: number
	}
}

export class YjsFsError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.name = new.target.name
		this.code = code
	}
}

export class AlreadyExistsError extends YjsFsError {
	constructor(path: string) {
		super('ALREADY_EXISTS', `Path already exists: ${path}`)
	}
}

export class EntryNotFoundError extends YjsFsError {
	constructor(path: string) {
		super('ENTRY_NOT_FOUND', `Path not found: ${path}`)
	}
}

export class InvalidPathError extends YjsFsError {
	constructor(path: string, reason?: string) {
		super('INVALID_PATH', reason ? `Invalid path ${path}: ${reason}` : `Invalid path: ${path}`)
	}
}

export class NotDirectoryError extends YjsFsError {
	constructor(path: string) {
		super('NOT_DIRECTORY', `Path is not a directory: ${path}`)
	}
}

export class NotFileError extends YjsFsError {
	constructor(path: string) {
		super('NOT_FILE', `Path is not a file: ${path}`)
	}
}

export class DirectoryNotEmptyError extends YjsFsError {
	constructor(path: string) {
		super('DIRECTORY_NOT_EMPTY', `Directory is not empty: ${path}`)
	}
}

export class RootMutationError extends YjsFsError {
	constructor(action: string) {
		super('ROOT_MUTATION', `Cannot ${action} the root directory`)
	}
}
