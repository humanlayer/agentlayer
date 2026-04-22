export type { YjsFilesystemOptions } from './filesystem'
export { YjsFilesystem } from './filesystem'
export type {
	LocalSelectionState,
	PresenceCursor,
	PresenceState,
	PresenceUser,
	ResolvedPresenceSelection,
} from './presence'
export {
	clearLocalSelection,
	colorFromId,
	getLocalPresenceState,
	getLocalSelection,
	getLocalSelectionState,
	resolveLocalSelectionState,
	setLocalPresenceState,
	setLocalSelection,
	updateLocalPresenceState,
} from './presence'
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
