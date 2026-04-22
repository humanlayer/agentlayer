type NamespaceNode = {
	entryId: string
	type: 'directory' | 'file'
	actualEntryId?: string
	actualContentId?: string
	contentId?: string
	content?: string
	children?: Set<string>
}

export type NamespaceModel = {
	nodes: Map<string, NamespaceNode>
	pathsById: Map<string, string>
	idByPath: Map<string, string>
	rootEntryId: string
	fileSequence: number
	directorySequence: number
}

export function createNamespaceModel(): NamespaceModel {
	const rootEntryId = 'root'
	const rootNode: NamespaceNode = {
		entryId: rootEntryId,
		type: 'directory',
		children: new Set(),
	}

	return {
		nodes: new Map([[rootEntryId, rootNode]]),
		pathsById: new Map([[rootEntryId, '/']]),
		idByPath: new Map([['/', rootEntryId]]),
		rootEntryId,
		fileSequence: 0,
		directorySequence: 0,
	}
}

export function modelExists(model: NamespaceModel, path: string): boolean {
	return model.idByPath.has(path)
}

export function modelMkdir(model: NamespaceModel, path: string): void {
	const parentPath = dirname(path)
	const _name = basename(path)
	const parentId = requiredId(model, parentPath)
	const parent = requiredNode(model, parentId)

	if (parent.type !== 'directory') {
		throw new Error(`Parent is not a directory: ${parentPath}`)
	}

	if (model.idByPath.has(path)) {
		throw new Error(`Path already exists: ${path}`)
	}

	const entryId = `dir-${model.directorySequence++}`
	model.nodes.set(entryId, { entryId, type: 'directory', children: new Set() })
	model.pathsById.set(entryId, path)
	model.idByPath.set(path, entryId)
	parent.children?.add(entryId)
}

export function modelCreateFile(
	model: NamespaceModel,
	path: string,
	content: string,
): { entryId: string; contentId: string } {
	const parentPath = dirname(path)
	const parentId = requiredId(model, parentPath)
	const parent = requiredNode(model, parentId)

	if (parent.type !== 'directory') {
		throw new Error(`Parent is not a directory: ${parentPath}`)
	}

	if (model.idByPath.has(path)) {
		throw new Error(`Path already exists: ${path}`)
	}

	const entryId = `file-${model.fileSequence}`
	const contentId = `content-${model.fileSequence}`
	model.fileSequence += 1
	model.nodes.set(entryId, { entryId, type: 'file', contentId, content })
	model.pathsById.set(entryId, path)
	model.idByPath.set(path, entryId)
	parent.children?.add(entryId)
	return { entryId, contentId }
}

export function modelWriteFile(model: NamespaceModel, path: string, content: string): void {
	const node = requiredFileNode(model, path)
	node.content = content
}

export function bindActualEntryIdentity(
	model: NamespaceModel,
	path: string,
	actualEntryId: string,
	actualContentId?: string,
): void {
	const node = requiredNode(model, requiredId(model, path))
	node.actualEntryId = actualEntryId

	if (node.type === 'file') {
		node.actualContentId = actualContentId
	}
}

export function modelEditFile(model: NamespaceModel, path: string, oldText: string, newText: string): void {
	const node = requiredFileNode(model, path)
	const content = node.content ?? ''
	const firstIndex = content.indexOf(oldText)

	if (firstIndex === -1) {
		throw new Error(`No match found for ${path}`)
	}

	if (content.indexOf(oldText, firstIndex + 1) !== -1) {
		throw new Error(`Multiple matches found for ${path}`)
	}

	node.content = `${content.slice(0, firstIndex)}${newText}${content.slice(firstIndex + oldText.length)}`
}

export function modelRename(model: NamespaceModel, fromPath: string, toPath: string): void {
	const entryId = requiredId(model, fromPath)
	const destinationParentPath = dirname(toPath)
	const destinationParentId = requiredId(model, destinationParentPath)
	const destinationParent = requiredNode(model, destinationParentId)

	if (destinationParent.type !== 'directory') {
		throw new Error(`Parent is not a directory: ${destinationParentPath}`)
	}

	if (model.idByPath.has(toPath)) {
		throw new Error(`Path already exists: ${toPath}`)
	}

	const previousParentPath = dirname(fromPath)
	const previousParentId = requiredId(model, previousParentPath)
	requiredNode(model, previousParentId).children?.delete(entryId)
	destinationParent.children?.add(entryId)

	for (const [id, currentPath] of Array.from(model.pathsById.entries())) {
		if (currentPath === fromPath || currentPath.startsWith(`${fromPath}/`)) {
			const suffix = currentPath.slice(fromPath.length)
			const nextPath = `${toPath}${suffix}`
			model.idByPath.delete(currentPath)
			model.idByPath.set(nextPath, id)
			model.pathsById.set(id, nextPath)
		}
	}
}

export function modelDelete(model: NamespaceModel, path: string): void {
	const entryId = requiredId(model, path)
	const node = requiredNode(model, entryId)

	if (node.type === 'directory' && (node.children?.size ?? 0) > 0) {
		throw new Error(`Directory not empty: ${path}`)
	}

	const parentPath = dirname(path)
	const parentId = requiredId(model, parentPath)
	requiredNode(model, parentId).children?.delete(entryId)
	model.nodes.delete(entryId)
	model.pathsById.delete(entryId)
	model.idByPath.delete(path)
}

export function listModel(
	model: NamespaceModel,
	path: string,
): Array<{ name: string; path: string; type: 'directory' | 'file' }> {
	const directoryId = requiredId(model, path)
	const directory = requiredNode(model, directoryId)

	if (directory.type !== 'directory') {
		throw new Error(`Not a directory: ${path}`)
	}

	return Array.from(directory.children ?? [])
		.map((entryId) => {
			const child = requiredNode(model, entryId)
			const childPath = requiredPath(model, entryId)
			return { name: basename(childPath), path: childPath, type: child.type }
		})
		.sort((left, right) => left.name.localeCompare(right.name))
}

export function statModel(
	model: NamespaceModel,
	path: string,
): { type: 'directory' | 'file'; contentId?: string; size?: number } {
	const node = requiredNode(model, requiredId(model, path))

	return {
		type: node.type,
		contentId: node.actualContentId,
		size: node.type === 'file' ? (node.content ?? '').length : undefined,
	}
}

export function actualEntryIdForPath(model: NamespaceModel, path: string): string | undefined {
	return requiredNode(model, requiredId(model, path)).actualEntryId
}

export function readModel(model: NamespaceModel, path: string): string {
	return requiredFileNode(model, path).content ?? ''
}

function requiredId(model: NamespaceModel, path: string): string {
	const entryId = model.idByPath.get(path)

	if (!entryId) {
		throw new Error(`Missing path: ${path}`)
	}

	return entryId
}

function requiredNode(model: NamespaceModel, entryId: string): NamespaceNode {
	const node = model.nodes.get(entryId)

	if (!node) {
		throw new Error(`Missing entry: ${entryId}`)
	}

	return node
}

function requiredPath(model: NamespaceModel, entryId: string): string {
	const path = model.pathsById.get(entryId)

	if (!path) {
		throw new Error(`Missing path for entry: ${entryId}`)
	}

	return path
}

function requiredFileNode(model: NamespaceModel, path: string): NamespaceNode & { type: 'file'; contentId: string } {
	const node = requiredNode(model, requiredId(model, path))

	if (node.type !== 'file' || !node.contentId) {
		throw new Error(`Not a file: ${path}`)
	}

	return node as NamespaceNode & { type: 'file'; contentId: string }
}

function dirname(path: string): string {
	if (path === '/') {
		return '/'
	}

	const parts = path.split('/').filter(Boolean)
	if (parts.length <= 1) {
		return '/'
	}

	return `/${parts.slice(0, -1).join('/')}`
}

function basename(path: string): string {
	if (path === '/') {
		return '/'
	}

	const parts = path.split('/').filter(Boolean)
	const name = parts.at(-1)

	if (!name) {
		throw new Error(`Missing basename: ${path}`)
	}

	return name
}
