import * as Y from 'yjs'
import {
	AlreadyExistsError,
	type DirectoryEntry,
	DirectoryNotEmptyError,
	type EntryDirent,
	type EntryId,
	type EntryMetadata,
	EntryNotFoundError,
	type FileEntry,
	type FilesystemTreeNode,
	InvalidPathError,
	type LookupResult,
	NotDirectoryError,
	NotFileError,
	RootMutationError,
} from './types'

const CATALOG_KEY = 'catalog'
const ENTRIES_KEY = 'catalog.entries'
const CHILDREN_KEY = 'catalog.children'
const PATH_INDEX_KEY = 'catalog.pathIndex'
const ROOT_ENTRY_ID_KEY = 'rootEntryId'
const ROOT_ENTRY_ID = 'root'

type EntryRecord = Y.Map<unknown>

// The catalog is the namespace document for the filesystem.
//
// It keeps all metadata needed to answer namespace questions without loading
// file content docs:
// - `entries`: entry metadata keyed by stable entry id
// - `children`: a flattened directoryId/name -> entry id index
// - `pathIndex`: convenience index for fast absolute-path lookups
// - `rootEntryId`: stable identity for `/`
//
// File content itself lives elsewhere; this file only manages namespace state.
//
// The child index is intentionally flattened instead of storing nested Y.Maps per
// directory. Nested shared types created independently on two replicas can race
// during sync and cause one side to keep the wrong child map. A flattened index
// avoids that whole class of replica-initialization bugs.

export type CatalogState = {
	doc: Y.Doc
	catalog: Y.Map<unknown>
	entries: Y.Map<EntryRecord>
	children: Y.Map<EntryId>
	pathIndex: Y.Map<EntryId>
	rootEntryId: EntryId
}

export function normalizePath(path: string): string {
	// Normalize all caller input into an absolute path so the rest of the
	// namespace layer can assume one canonical representation.
	if (path.includes('\0')) {
		throw new InvalidPathError(path, 'null bytes are not supported')
	}

	const segments = path
		.split('/')
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0)

	for (const segment of segments) {
		if (segment === '.' || segment === '..') {
			throw new InvalidPathError(path, `segment ${segment} is not supported`)
		}
	}

	if (segments.length === 0) {
		return '/'
	}

	return `/${segments.join('/')}`
}

export function createCatalogState(doc: Y.Doc): CatalogState {
	// Create or recover the long-lived catalog collections from the root Y.Doc.
	const catalog = doc.getMap<unknown>(CATALOG_KEY)
	const entries = doc.getMap<EntryRecord>(ENTRIES_KEY)
	const children = doc.getMap<EntryId>(CHILDREN_KEY)
	const pathIndex = doc.getMap<EntryId>(PATH_INDEX_KEY)

	const existingRootEntryId = catalog.get(ROOT_ENTRY_ID_KEY)
	const rootEntryId = typeof existingRootEntryId === 'string' ? existingRootEntryId : ROOT_ENTRY_ID

	doc.transact(() => {
		// Ensure `/` always exists as a first-class directory entry with a stable id.
		if (catalog.get(ROOT_ENTRY_ID_KEY) !== rootEntryId) {
			catalog.set(ROOT_ENTRY_ID_KEY, rootEntryId)
		}

		if (!entries.has(rootEntryId)) {
			entries.set(rootEntryId, createEntryRecord(createDirectoryEntry(rootEntryId, null, '', Date.now())))
		}

		if (pathIndex.get('/') !== rootEntryId) {
			pathIndex.set('/', rootEntryId)
		}
	})

	return {
		doc,
		catalog,
		entries,
		children,
		pathIndex,
		rootEntryId,
	}
}

export function resolvePath(state: CatalogState, path: string): EntryId | undefined {
	// Resolve an absolute path to a stable entry id. We prefer the cached path
	// index, but can fall back to walking parent/child maps if needed.
	refreshCatalogState(state)
	const normalizedPath = normalizePath(path)
	const indexedEntryId = state.pathIndex.get(normalizedPath)

	if (typeof indexedEntryId === 'string') {
		return indexedEntryId
	}

	if (normalizedPath === '/') {
		return state.rootEntryId
	}

	let currentEntryId = state.rootEntryId

	for (const segment of splitPath(normalizedPath)) {
		const nextEntryId = state.children.get(childLookupKey(currentEntryId, segment))

		if (typeof nextEntryId !== 'string') {
			return undefined
		}

		currentEntryId = nextEntryId
	}

	return currentEntryId
}

export function lookupPath(state: CatalogState, path: string): LookupResult | undefined {
	// Lookups return both stable identity and the parsed entry metadata so the
	// filesystem facade can answer higher-level queries without duplicating logic.
	refreshCatalogState(state)
	const normalizedPath = normalizePath(path)
	const entryId = resolvePath(state, normalizedPath)

	if (!entryId) {
		return undefined
	}

	const entry = getEntry(state, entryId)

	if (!entry) {
		return undefined
	}

	return {
		entryId,
		entry,
		path: normalizedPath,
	}
}

export function getEntry(state: CatalogState, entryId: EntryId): EntryMetadata | undefined {
	// Entry records are stored as Y.Maps so metadata remains collaborative and
	// can evolve field-by-field over time.
	refreshCatalogState(state)
	const record = state.entries.get(entryId)

	if (!(record instanceof Y.Map)) {
		return undefined
	}

	return parseEntryRecord(record)
}

export function getPathForEntryId(state: CatalogState, entryId: EntryId): string | undefined {
	// Reconstruct the current absolute path by walking parent links back to root.
	refreshCatalogState(state)
	const entry = getEntry(state, entryId)

	if (!entry) {
		return undefined
	}

	if (entry.parentId === null) {
		return '/'
	}

	const segments: string[] = []
	let currentEntry: EntryMetadata | undefined = entry

	while (currentEntry && currentEntry.parentId !== null) {
		segments.push(currentEntry.name)
		currentEntry = getEntry(state, currentEntry.parentId)
	}

	if (!currentEntry) {
		return undefined
	}

	return `/${segments.reverse().join('/')}`
}

export function listDirectoryEntries(state: CatalogState, directoryId: EntryId): EntryDirent[] {
	// Directory listings are driven by the explicit child map instead of path
	// prefix scanning, which is the key shift away from the old path-keyed model.
	refreshCatalogState(state)
	const directory = getEntry(state, directoryId)

	if (!directory) {
		const directoryPath = getPathForEntryId(state, directoryId) ?? directoryId
		throw new EntryNotFoundError(directoryPath)
	}

	if (directory.type !== 'directory') {
		const directoryPath = getPathForEntryId(state, directoryId) ?? directory.name
		throw new NotDirectoryError(directoryPath)
	}

	const directoryPath = getPathForEntryId(state, directoryId) ?? '/'

	return getChildrenForDirectory(state, directoryId)
		.sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
		.flatMap(([name, childEntryId]) => {
			const childEntry = getEntry(state, childEntryId)

			if (!childEntry) {
				return []
			}

			return [
				{
					entryId: childEntryId,
					name,
					path: joinPath(directoryPath, name),
					type: childEntry.type,
				},
			]
		})
}

export function buildTree(state: CatalogState, path = '/'): FilesystemTreeNode {
	refreshCatalogState(state)
	const lookup = lookupRequired(state, normalizePath(path))
	return buildTreeNode(state, lookup.entryId, lookup.path)
}

export function mkdirInCatalog(state: CatalogState, path: string): EntryId {
	// Create a directory entry and wire it into the parent/child namespace graph.
	refreshCatalogState(state)
	const normalizedPath = normalizePath(path)

	if (normalizedPath === '/') {
		throw new AlreadyExistsError(normalizedPath)
	}

	const existingEntryId = resolvePath(state, normalizedPath)

	if (existingEntryId) {
		throw new AlreadyExistsError(normalizedPath)
	}

	const parentPath = dirname(normalizedPath)
	const parentEntryId = resolvePath(state, parentPath)

	if (!parentEntryId) {
		throw new EntryNotFoundError(parentPath)
	}

	const parentEntry = getEntry(state, parentEntryId)

	if (!parentEntry) {
		throw new EntryNotFoundError(parentPath)
	}

	if (parentEntry.type !== 'directory') {
		throw new NotDirectoryError(parentPath)
	}

	const directoryName = basename(normalizedPath)
	const createdAt = Date.now()
	const entryId = crypto.randomUUID()
	const entry = createDirectoryEntry(entryId, parentEntryId, directoryName, createdAt)

	state.doc.transact(() => {
		state.entries.set(entryId, createEntryRecord(entry))
		state.children.set(childLookupKey(parentEntryId, directoryName), entryId)
		state.pathIndex.set(normalizedPath, entryId)
		setEntryModifiedAt(state, parentEntryId, createdAt)
	})

	return entryId
}

export function createFileInCatalog(
	state: CatalogState,
	path: string,
	contentId: string,
	size: number,
	encoding: 'text' | 'binary' = 'text',
): EntryId {
	// Files participate in the same namespace graph as directories, but point at
	// a separate stable content id so future moves/renames do not recreate text state.
	refreshCatalogState(state)
	const normalizedPath = normalizePath(path)

	if (normalizedPath === '/') {
		throw new AlreadyExistsError(normalizedPath)
	}

	if (resolvePath(state, normalizedPath)) {
		throw new AlreadyExistsError(normalizedPath)
	}

	const parentPath = dirname(normalizedPath)
	const parentEntryId = resolveRequiredDirectoryId(state, parentPath)
	const fileName = basename(normalizedPath)
	const createdAt = Date.now()
	const entryId = crypto.randomUUID()
	const entry = createFileEntry(entryId, parentEntryId, fileName, contentId, size, createdAt, encoding)

	state.doc.transact(() => {
		state.entries.set(entryId, createEntryRecord(entry))
		state.children.set(childLookupKey(parentEntryId, fileName), entryId)
		state.pathIndex.set(normalizedPath, entryId)
		setEntryModifiedAt(state, parentEntryId, createdAt)
	})

	return entryId
}

export function renameInCatalog(state: CatalogState, fromPath: string, toPath: string): EntryId {
	// Rename mutates namespace links only. The entry id stays the same and file
	// content ids stay the same, which is the core identity-preservation rule.
	refreshCatalogState(state)
	const normalizedFromPath = normalizePath(fromPath)
	const normalizedToPath = normalizePath(toPath)

	if (normalizedFromPath === '/') {
		throw new RootMutationError('rename')
	}

	if (normalizedFromPath === normalizedToPath) {
		const existingEntryId = resolvePath(state, normalizedFromPath)
		if (!existingEntryId) {
			throw new EntryNotFoundError(normalizedFromPath)
		}
		return existingEntryId
	}

	const lookup = lookupRequired(state, normalizedFromPath)

	if (resolvePath(state, normalizedToPath)) {
		throw new AlreadyExistsError(normalizedToPath)
	}

	const destinationParentPath = dirname(normalizedToPath)
	const destinationParentId = resolveRequiredDirectoryId(state, destinationParentPath)
	const nextName = basename(normalizedToPath)
	const previousParentId = lookup.entry.parentId

	if (previousParentId === null) {
		throw new RootMutationError('rename')
	}

	assertNoDescendantMove(state, lookup.entryId, destinationParentId, normalizedToPath)

	const nextModifiedAt = Date.now()
	const nextRecord = getRequiredEntryRecord(state, lookup.entryId)
	const previousName = lookup.entry.name

	state.doc.transact(() => {
		nextRecord.set('parentId', destinationParentId)
		nextRecord.set('name', nextName)
		nextRecord.set('modifiedAt', nextModifiedAt)

		state.children.delete(childLookupKey(previousParentId, previousName))
		state.children.set(childLookupKey(destinationParentId, nextName), lookup.entryId)

		removePathIndexForEntry(state, lookup.entryId, normalizedFromPath)
		populatePathIndexForEntry(state, lookup.entryId, normalizedToPath)

		setEntryModifiedAt(state, previousParentId, nextModifiedAt)
		setEntryModifiedAt(state, destinationParentId, nextModifiedAt)
	})

	return lookup.entryId
}

export function deleteEntryInCatalog(state: CatalogState, path: string): EntryMetadata {
	// Deletion removes the namespace entry and returns the removed metadata so the
	// filesystem layer can clean up related state such as file content docs.
	refreshCatalogState(state)
	const normalizedPath = normalizePath(path)

	if (normalizedPath === '/') {
		throw new RootMutationError('delete')
	}

	const lookup = lookupRequired(state, normalizedPath)

	if (lookup.entry.type === 'directory' && listDirectoryEntries(state, lookup.entryId).length > 0) {
		throw new DirectoryNotEmptyError(normalizedPath)
	}

	const parentId = lookup.entry.parentId

	if (parentId === null) {
		throw new RootMutationError('delete')
	}

	const deletedEntry = lookup.entry
	const deletedAt = Date.now()

	state.doc.transact(() => {
		state.children.delete(childLookupKey(parentId, lookup.entry.name))
		state.entries.delete(lookup.entryId)
		removePathIndexForEntry(state, lookup.entryId, normalizedPath)
		setEntryModifiedAt(state, parentId, deletedAt)
	})

	return deletedEntry
}

export function updateFileMetadata(state: CatalogState, entryId: EntryId, size: number): void {
	// Content edits update file metadata in-place without touching namespace links.
	refreshCatalogState(state)
	const record = getRequiredEntryRecord(state, entryId)
	const type = record.get('type')

	if (type !== 'file') {
		const path = getPathForEntryId(state, entryId) ?? entryId
		throw new NotFileError(path)
	}

	const modifiedAt = Date.now()
	record.set('size', size)
	record.set('modifiedAt', modifiedAt)
}

function createDirectoryEntry(
	entryId: EntryId,
	parentId: EntryId | null,
	name: string,
	timestamp: number,
): DirectoryEntry {
	return {
		id: entryId,
		parentId,
		name,
		type: 'directory',
		createdAt: timestamp,
		modifiedAt: timestamp,
	}
}

function refreshCatalogState(state: CatalogState): void {
	state.entries = state.doc.getMap<EntryRecord>(ENTRIES_KEY)
	state.children = state.doc.getMap<EntryId>(CHILDREN_KEY)
	state.pathIndex = state.doc.getMap<EntryId>(PATH_INDEX_KEY)

	const rootEntryId = state.catalog.get(ROOT_ENTRY_ID_KEY)
	if (typeof rootEntryId === 'string') {
		state.rootEntryId = rootEntryId
	}
}

function createFileEntry(
	entryId: EntryId,
	parentId: EntryId,
	name: string,
	contentId: string,
	size: number,
	timestamp: number,
	encoding: 'text' | 'binary' = 'text',
): FileEntry {
	return {
		id: entryId,
		parentId,
		name,
		type: 'file',
		contentId,
		size,
		encoding,
		createdAt: timestamp,
		modifiedAt: timestamp,
	}
}

function createEntryRecord(entry: EntryMetadata): EntryRecord {
	const record = new Y.Map<unknown>()
	record.set('id', entry.id)
	record.set('parentId', entry.parentId)
	record.set('name', entry.name)
	record.set('type', entry.type)
	record.set('createdAt', entry.createdAt)
	record.set('modifiedAt', entry.modifiedAt)

	if (entry.type === 'file') {
		record.set('contentId', entry.contentId)
		record.set('size', entry.size)
		record.set('encoding', entry.encoding)
	}

	return record
}

function parseEntryRecord(record: EntryRecord): EntryMetadata | undefined {
	const id = record.get('id')
	const parentId = record.get('parentId')
	const name = record.get('name')
	const type = record.get('type')
	const createdAt = record.get('createdAt')
	const modifiedAt = record.get('modifiedAt')

	if (
		typeof id !== 'string' ||
		!(typeof parentId === 'string' || parentId === null) ||
		typeof name !== 'string' ||
		(type !== 'directory' && type !== 'file') ||
		typeof createdAt !== 'number' ||
		typeof modifiedAt !== 'number'
	) {
		return undefined
	}

	if (type === 'file') {
		const contentId = record.get('contentId')
		const size = record.get('size')
		const encoding = record.get('encoding')

		if (
			typeof contentId !== 'string' ||
			typeof size !== 'number' ||
			(encoding !== 'text' && encoding !== 'binary' && encoding !== undefined)
		) {
			return undefined
		}

		return {
			id,
			parentId,
			name,
			type,
			contentId,
			size,
			encoding: encoding ?? 'text',
			createdAt,
			modifiedAt,
		}
	}

	return {
		id,
		parentId,
		name,
		type,
		createdAt,
		modifiedAt,
	}
}
function getRequiredEntryRecord(state: CatalogState, entryId: EntryId): EntryRecord {
	const record = state.entries.get(entryId)

	if (!(record instanceof Y.Map)) {
		const path = getPathForEntryId(state, entryId) ?? entryId
		throw new EntryNotFoundError(path)
	}

	return record
}

function setEntryModifiedAt(state: CatalogState, entryId: EntryId, modifiedAt: number): void {
	const record = state.entries.get(entryId)

	if (!(record instanceof Y.Map)) {
		return
	}

	record.set('modifiedAt', modifiedAt)
}

function lookupRequired(state: CatalogState, path: string): LookupResult {
	const lookup = lookupPath(state, path)

	if (!lookup) {
		throw new EntryNotFoundError(path)
	}

	return lookup
}

function resolveRequiredDirectoryId(state: CatalogState, path: string): EntryId {
	const lookup = lookupRequired(state, path)

	if (lookup.entry.type !== 'directory') {
		throw new NotDirectoryError(path)
	}

	return lookup.entryId
}

function removePathIndexForEntry(state: CatalogState, entryId: EntryId, rootPath: string): void {
	for (const [path, indexedEntryId] of state.pathIndex.entries()) {
		if (indexedEntryId !== entryId && !path.startsWith(`${rootPath}/`)) {
			continue
		}

		if (indexedEntryId === entryId || isDescendantPath(path, rootPath)) {
			state.pathIndex.delete(path)
		}
	}
}

function populatePathIndexForEntry(state: CatalogState, entryId: EntryId, rootPath: string): void {
	state.pathIndex.set(rootPath, entryId)

	for (const [name, childEntryId] of getChildrenForDirectory(state, entryId)) {
		populatePathIndexForEntry(state, childEntryId, joinPath(rootPath, name))
	}
}

function getChildrenForDirectory(state: CatalogState, directoryId: EntryId): Array<[string, EntryId]> {
	const prefix = `${directoryId}\0`
	const children: Array<[string, EntryId]> = []

	for (const [key, childEntryId] of state.children.entries()) {
		if (!key.startsWith(prefix)) {
			continue
		}

		children.push([key.slice(prefix.length), childEntryId])
	}

	return children
}

function buildTreeNode(state: CatalogState, entryId: EntryId, path: string): FilesystemTreeNode {
	const entry = getEntry(state, entryId)

	if (!entry) {
		throw new EntryNotFoundError(path)
	}

	if (entry.type === 'file') {
		return {
			entryId,
			name: path === '/' ? '/' : entry.name,
			path,
			type: 'file',
		}
	}

	const children = getChildrenForDirectory(state, entryId)
		.sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
		.map(([name, childEntryId]) => buildTreeNode(state, childEntryId, joinPath(path, name)))

	return {
		entryId,
		name: path === '/' ? '/' : entry.name,
		path,
		type: 'directory',
		children,
	}
}

function childLookupKey(directoryId: EntryId, name: string): string {
	return `${directoryId}\0${name}`
}

function assertNoDescendantMove(
	state: CatalogState,
	entryId: EntryId,
	destinationParentId: EntryId,
	destinationPath: string,
): void {
	let currentEntryId: EntryId | null = destinationParentId

	while (currentEntryId !== null) {
		if (currentEntryId === entryId) {
			throw new InvalidPathError(destinationPath, 'cannot move an entry into its own descendant')
		}

		const currentEntry = getEntry(state, currentEntryId)
		currentEntryId = currentEntry?.parentId ?? null
	}
}

function isDescendantPath(path: string, rootPath: string): boolean {
	return path.startsWith(`${rootPath}/`)
}

function splitPath(path: string): string[] {
	return path === '/' ? [] : path.slice(1).split('/')
}

function dirname(path: string): string {
	const segments = splitPath(path)

	if (segments.length <= 1) {
		return '/'
	}

	return `/${segments.slice(0, -1).join('/')}`
}

function basename(path: string): string {
	const segments = splitPath(path)
	const name = segments.at(-1)

	if (!name) {
		throw new InvalidPathError(path, 'missing basename')
	}

	return name
}

function joinPath(directoryPath: string, name: string): string {
	return directoryPath === '/' ? `/${name}` : `${directoryPath}/${name}`
}
