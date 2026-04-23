export type { YjsFilesystemOptions } from './filesystem'
export { CatalogStore, CommentStore, ContentStore, PresenceStore, YjsFilesystem } from './filesystem'
export type {
	LocalSelectionState,
	PresenceCursor,
	PresenceState,
	PresenceUser,
	ResolvedPresenceSelection,
} from './filesystem/presence'
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
} from './filesystem/presence'
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
	FilesystemTreeNode,
	LookupResult,
} from './filesystem/types'
export {
	AlreadyExistsError,
	DirectoryNotEmptyError,
	EntryNotFoundError,
	InvalidPathError,
	NotBinaryFileError,
	NotDirectoryError,
	NotFileError,
	NotTextFileError,
	RootMutationError,
	YjsFsError,
} from './filesystem/types'
