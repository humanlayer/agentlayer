export type { YjsFilesystemOptions } from './filesystem'
export { YjsFilesystem } from './filesystem'
export type {
	DurableStreamsClientOptions,
	DurableStreamsServerOptions,
} from './surface'
export type {
	CommentAnchor,
	CommentReply,
	ContentId,
	DirectoryEntry,
	EditResult,
	EntryDirent,
	EntryId,
	EntryMetadata,
	EntryStat,
	EntryType,
	FileComment,
	FileEntry,
	LookupResult,
} from './types'
export {
	AlreadyExistsError,
	DirectoryNotEmptyError,
	EntryNotFoundError,
	InvalidPathError,
	NotDirectoryError,
	NotFileError,
	RootMutationError,
	YjsFsError,
} from './types'
