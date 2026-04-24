/** Internal filesystem module surface shared by the package entrypoints. */
export { CatalogStore } from './catalog-store'
export { CommentStore } from './comment-store'
export { ContentStore } from './content-store'
export { PresenceStore } from './presence-store'
export {
	AlreadyExistsError,
	DirectoryNotEmptyError,
	EntryNotFoundError,
	type FilesystemTreeNode,
	InvalidPathError,
	NotBinaryFileError,
	NotDirectoryError,
	NotFileError,
	NotTextFileError,
	RootMutationError,
	YjsFsError,
} from './types'
export type { YjsFilesystemOptions } from './yjs-filesystem'
export { YjsFilesystem } from './yjs-filesystem'
