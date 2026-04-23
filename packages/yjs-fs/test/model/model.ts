export type ModelCommentReply = {
	id: string
	actualId?: string
	parentId: string
	author: string
	body: string
}

export type ModelComment = {
	id: string
	actualId?: string
	author: string
	body: string
	anchorIndex: number
	anchorLength: number
	replies: ModelCommentReply[]
	resolved: boolean
	resolvedBy?: string
}

type NamespaceNode = {
	entryId: string
	type: 'directory' | 'file'
	actualEntryId?: string
	actualContentId?: string
	contentId?: string
	content?: string
	binaryContent?: Uint8Array
	encoding?: 'text' | 'binary'
	comments?: ModelComment[]
	children?: Set<string>
}

export type NamespaceModel = {
	nodes: Map<string, NamespaceNode>
	pathsById: Map<string, string>
	idByPath: Map<string, string>
	rootEntryId: string
	fileSequence: number
	directorySequence: number
	commentSequence: number
	replySequence: number
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
		commentSequence: 0,
		replySequence: 0,
	}
}

export function modelExists(model: NamespaceModel, path: string): boolean {
	return model.idByPath.has(path)
}

export function modelMkdir(model: NamespaceModel, path: string): void {
	const parentPath = dirname(path)
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
	model.nodes.set(entryId, { entryId, type: 'file', contentId, content, encoding: 'text', comments: [] })
	model.pathsById.set(entryId, path)
	model.idByPath.set(path, entryId)
	parent.children?.add(entryId)
	return { entryId, contentId }
}

export function modelWriteFile(model: NamespaceModel, path: string, content: string): void {
	const node = requiredTextFileNode(model, path)
	node.content = content
}

export function modelCreateBinaryFile(
	model: NamespaceModel,
	path: string,
	content: Uint8Array,
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
	model.nodes.set(entryId, {
		entryId,
		type: 'file',
		contentId,
		binaryContent: content,
		encoding: 'binary',
	})
	model.pathsById.set(entryId, path)
	model.idByPath.set(path, entryId)
	parent.children?.add(entryId)
	return { entryId, contentId }
}

export function modelWriteBinaryFile(model: NamespaceModel, path: string, content: Uint8Array): void {
	const node = requiredBinaryFileNode(model, path)
	node.binaryContent = content
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
	const node = requiredTextFileNode(model, path)
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

export function modelAddComment(
	model: NamespaceModel,
	path: string,
	anchor: { index: number; length: number },
	body: string,
	author: string,
): string {
	const node = requiredTextFileNode(model, path)
	const commentId = `comment-${model.commentSequence++}`
	const comments = node.comments ?? []

	comments.push({
		id: commentId,
		author,
		body,
		anchorIndex: anchor.index,
		anchorLength: anchor.length,
		replies: [],
		resolved: false,
	})
	node.comments = comments
	return commentId
}

export function bindActualCommentIdentity(
	model: NamespaceModel,
	path: string,
	commentId: string,
	actualCommentId: string,
): void {
	requiredComment(model, path, commentId).actualId = actualCommentId
}

export function modelReplyToComment(
	model: NamespaceModel,
	path: string,
	commentId: string,
	body: string,
	author: string,
): string {
	const comment = requiredComment(model, path, commentId)
	const replyId = `reply-${model.replySequence++}`

	comment.replies.push({
		id: replyId,
		parentId: commentId,
		author,
		body,
	})

	return replyId
}

export function bindActualReplyIdentity(
	model: NamespaceModel,
	path: string,
	commentId: string,
	replyId: string,
	actualReplyId: string,
): void {
	const reply = requiredComment(model, path, commentId).replies.find((candidate) => candidate.id === replyId)
	if (!reply) {
		throw new Error(`Missing reply: ${replyId}`)
	}

	reply.actualId = actualReplyId
}

export function modelResolveComment(model: NamespaceModel, path: string, commentId: string, author: string): void {
	const comment = requiredComment(model, path, commentId)
	comment.resolved = !comment.resolved
	comment.resolvedBy = comment.resolved ? author : undefined
}

export function listModelComments(model: NamespaceModel, path: string): ModelComment[] {
	return [...(requiredTextFileNode(model, path).comments ?? [])]
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
): { type: 'directory' | 'file'; contentId?: string; size?: number; encoding?: 'text' | 'binary' } {
	const node = requiredNode(model, requiredId(model, path))

	return {
		type: node.type,
		contentId: node.actualContentId,
		size:
			node.type === 'file'
				? node.encoding === 'binary'
					? (node.binaryContent?.length ?? 0)
					: (node.content ?? '').length
				: undefined,
		encoding: node.type === 'file' ? (node.encoding ?? 'text') : undefined,
	}
}

export function actualEntryIdForPath(model: NamespaceModel, path: string): string | undefined {
	return requiredNode(model, requiredId(model, path)).actualEntryId
}

export function readModel(model: NamespaceModel, path: string): string {
	return requiredTextFileNode(model, path).content ?? ''
}

export function readModelBinary(model: NamespaceModel, path: string): Uint8Array {
	return requiredBinaryFileNode(model, path).binaryContent ?? new Uint8Array(0)
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

function requiredComment(model: NamespaceModel, path: string, commentId: string): ModelComment {
	const comment = requiredTextFileNode(model, path).comments?.find((candidate) => candidate.id === commentId)
	if (!comment) {
		throw new Error(`Missing comment: ${commentId}`)
	}

	return comment
}

function requiredFileNode(model: NamespaceModel, path: string): NamespaceNode & { type: 'file'; contentId: string } {
	const node = requiredNode(model, requiredId(model, path))

	if (node.type !== 'file' || !node.contentId) {
		throw new Error(`Not a file: ${path}`)
	}

	return node as NamespaceNode & { type: 'file'; contentId: string }
}

function requiredTextFileNode(
	model: NamespaceModel,
	path: string,
): NamespaceNode & { type: 'file'; contentId: string; encoding?: 'text' } {
	const node = requiredFileNode(model, path)

	if (node.encoding === 'binary') {
		throw new Error(`Not a text file: ${path}`)
	}

	return node as NamespaceNode & { type: 'file'; contentId: string; encoding?: 'text' }
}

function requiredBinaryFileNode(
	model: NamespaceModel,
	path: string,
): NamespaceNode & { type: 'file'; contentId: string; encoding: 'binary' } {
	const node = requiredFileNode(model, path)

	if (node.encoding !== 'binary') {
		throw new Error(`Not a binary file: ${path}`)
	}

	return node as NamespaceNode & { type: 'file'; contentId: string; encoding: 'binary' }
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
