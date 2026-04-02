/**
 * @durable-streams/stream-fs
 *
 * A shared filesystem for AI agents built on durable streams.
 *
 * @example
 * ```typescript
 * import { StreamFilesystem } from "@durable-streams/stream-fs"
 *
 * const fs = new StreamFilesystem({
 *   baseUrl: "http://localhost:8787",
 *   streamPrefix: "/fs/myproject",
 * })
 *
 * await fs.initialize()
 *
 * // Create and read files
 * await fs.createFile("/notes.md", "# My Notes\n\nHello, world!")
 * const content = await fs.readTextFile("/notes.md")
 *
 * // List directories
 * const entries = await fs.list("/")
 *
 * // Clean up
 * fs.close()
 * ```
 */

export type { Comment } from './comments-state'
export { COMMENT_COLLECTION_TYPE, commentSchema, commentStateSchema } from './comments-state'
export { METADATA_COLLECTION_TYPE, StreamFilesystem } from './filesystem'
export { metadataStateSchema } from './metadata-state'
export type {
	BaseMetadata,
	ContentEvent,
	ContentType,
	CreateFileOptions,
	DirectoryMetadata,
	Entry,
	EntryType,
	FileMetadata,
	InitContentEvent,
	Metadata,
	PatchContentEvent,
	ReplaceContentEvent,
	Stat,
	StreamFilesystemOptions,
	WatchEvent,
	WatchEventType,
	Watcher,
	WatchOptions,
} from './types'
export {
	DirectoryNotEmptyError,
	ExistsError,
	IsDirectoryError,
	isDirectoryMetadata,
	isFileMetadata,
	isInitEvent,
	isPatchEvent,
	isReplaceEvent,
	NotDirectoryError,
	NotFoundError,
	PatchApplicationError,
	PreconditionFailedError,
	StreamFsError,
} from './types'
export {
	applyPatch,
	basename,
	calculateChecksum,
	canApplyPatch,
	createPatch,
	decodeBase64,
	detectContentType,
	detectMimeType,
	dirname,
	encodeBase64,
	generateContentStreamId,
	isTextContent,
	joinPath,
	normalizePath,
} from './utils'
