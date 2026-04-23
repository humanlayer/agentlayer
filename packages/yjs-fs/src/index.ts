export type { DurableStreamsDevServer } from './durable-streams/server'
export { defineDurableStreamsServer, startDurableStreamsDevServer } from './durable-streams/server'
export type {
	DurableStreamsBindingDescriptor,
	DurableStreamsBindingTarget,
	DurableStreamsClient,
	DurableStreamsClientSession,
	DurableStreamsContentBindingChange,
	DurableStreamsTransportMode,
} from './durable-streams/shared'
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
export type {
	DurableStreamsClientOptions,
	DurableStreamsServerOptions,
} from './surface'
