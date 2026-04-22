import { expect } from 'bun:test'
import fc from 'fast-check'
import { YjsFilesystem } from '../../src'
import {
	actualEntryIdForPath,
	bindActualCommentIdentity,
	bindActualEntryIdentity,
	bindActualReplyIdentity,
	createNamespaceModel,
	listModel,
	listModelComments,
	modelAddComment,
	modelCreateFile,
	modelDelete,
	modelEditFile,
	modelExists,
	modelMkdir,
	modelRename,
	modelReplyToComment,
	modelResolveComment,
	modelWriteFile,
	type ModelComment,
	type NamespaceModel,
	readModel,
	statModel,
} from './model'

type CommandContext = {
	model: NamespaceModel
	filesystem: YjsFilesystem
}

export type NamespaceCommand = {
	label: string
	run(context: CommandContext): void
}

export function createCommandContext(): CommandContext {
	const filesystem = new YjsFilesystem()
	const model = createNamespaceModel()
	const rootLookup = filesystem.lookup('/')

	if (rootLookup) {
		bindActualEntryIdentity(model, '/', rootLookup.entryId)
	}

	return {
		model,
		filesystem,
	}
}

export function namespaceCommandArbitrary(): fc.Arbitrary<NamespaceCommand> {
	return fc.oneof(
		createDirectoryCommandArbitrary(),
		createFileCommandArbitrary(),
		writeFileCommandArbitrary(),
		editFileCommandArbitrary(),
		addCommentCommandArbitrary(),
		replyToCommentCommandArbitrary(),
		resolveCommentCommandArbitrary(),
		renameCommandArbitrary(),
		deleteCommandArbitrary(),
	)
}

export function assertFilesystemMatchesModel(context: CommandContext): void {
	for (const [path] of context.model.idByPath.entries()) {
		if (path === '/') {
			continue
		}

		const expectedStat = statModel(context.model, path)
		const actualLookup = context.filesystem.lookup(path)
		expect(actualLookup).toBeDefined()
		expect(context.filesystem.exists(path)).toBe(true)
		expect(actualLookup?.entryId).toBe(actualEntryIdForPath(context.model, path))

		const actualStat = context.filesystem.stat(path)
		expect(actualStat.type).toBe(expectedStat.type)

		if (expectedStat.type === 'file') {
			expect(actualStat.contentId).toBe(expectedStat.contentId)
			expect(actualStat.size).toBe(expectedStat.size)

			const actualContent = context.filesystem.readFile(path)
			const expectedContent = readModel(context.model, path)
			expect(actualContent).toBe(expectedContent)
			assertCommentsMatchModel(context, path)
		}
	}

	for (const [path] of collectExpectedDirectories(context.model)) {
		const expectedListing = listModel(context.model, path)
		const actualListing = context.filesystem.list(path)

		expect(actualListing.length).toBe(expectedListing.length)

		for (let index = 0; index < expectedListing.length; index += 1) {
			const expectedEntry = expectedListing[index]
			const actualEntry = actualListing[index]

			expect(actualEntry).toBeDefined()
			expect(expectedEntry).toBeDefined()
			expect(actualEntry?.name).toBe(expectedEntry?.name)
			expect(actualEntry?.path).toBe(expectedEntry?.path)
			expect(actualEntry?.type).toBe(expectedEntry?.type)
		}
	}
}

function createDirectoryCommandArbitrary(): fc.Arbitrary<NamespaceCommand> {
	return pathArbitrary('dir').map((path) => ({
		label: `mkdir(${path})`,
		run(context) {
			if (!canCreateAtPath(context.model, path)) {
				return
			}

			modelMkdir(context.model, path)
			const entryId = context.filesystem.mkdir(path)
			bindActualEntryIdentity(context.model, path, entryId)
		},
	}))
}

function createFileCommandArbitrary(): fc.Arbitrary<NamespaceCommand> {
	return fc
		.record({
			path: pathArbitrary('file'),
			content: fc.string({ maxLength: 12 }),
		})
		.map(({ path, content }) => ({
			label: `createFile(${path})`,
			run(context) {
				if (!canCreateAtPath(context.model, path)) {
					return
				}

				modelCreateFile(context.model, path, content)
				const entryId = context.filesystem.createFile(path, content)
				const stat = context.filesystem.stat(path)
				bindActualEntryIdentity(context.model, path, entryId, stat.contentId)
			},
		}))
}

function writeFileCommandArbitrary(): fc.Arbitrary<NamespaceCommand> {
	return fc
		.record({
			path: pathArbitrary('write'),
			content: fc.string({ maxLength: 12 }),
		})
		.map(({ path, content }) => ({
			label: `writeFile(${path})`,
			run(context) {
				if (!modelExists(context.model, path) || statModel(context.model, path).type !== 'file') {
					return
				}

				modelWriteFile(context.model, path, content)
				context.filesystem.writeFile(path, content)
			},
		}))
}

function editFileCommandArbitrary(): fc.Arbitrary<NamespaceCommand> {
	return pathArbitrary('edit').map((path) => ({
		label: `editFile(${path})`,
		run(context) {
			if (!modelExists(context.model, path) || statModel(context.model, path).type !== 'file') {
				return
			}

			const content = readModel(context.model, path)
			if (content.length === 0) {
				return
			}

			const needle = content.slice(0, Math.max(1, Math.min(3, content.length)))
			if (content.indexOf(needle) !== content.lastIndexOf(needle)) {
				return
			}

			const replacement = `${needle}!`
			modelEditFile(context.model, path, needle, replacement)
			context.filesystem.editFile(path, needle, replacement)
		},
	}))
}

function addCommentCommandArbitrary(): fc.Arbitrary<NamespaceCommand> {
	return fc
		.record({
			path: pathArbitrary('comment'),
			author: authorArbitrary(),
			body: commentBodyArbitrary(),
		})
		.map(({ path, author, body }) => ({
			label: `addComment(${path})`,
			run(context) {
				if (!isFilePath(context.model, path)) {
					return
				}

				const content = readModel(context.model, path)
				const anchor = anchorForContent(content)
				if (!anchor) {
					return
				}

				const commentId = modelAddComment(context.model, path, anchor, body, author)
				const actualCommentId = context.filesystem.addComment(path, anchor, body, author)
				bindActualCommentIdentity(context.model, path, commentId, actualCommentId)
			},
		}))
}

function replyToCommentCommandArbitrary(): fc.Arbitrary<NamespaceCommand> {
	return fc
		.record({
			path: pathArbitrary('reply'),
			author: authorArbitrary(),
			body: commentBodyArbitrary(),
		})
		.map(({ path, author, body }) => ({
			label: `replyToComment(${path})`,
			run(context) {
				if (!isFilePath(context.model, path)) {
					return
				}

				const comment = firstOpenComment(context.model, path)
				if (!comment?.actualId) {
					return
				}

				const replyId = modelReplyToComment(context.model, path, comment.id, body, author)
				const actualReplyId = context.filesystem.replyToComment(path, comment.actualId, body, author)
				bindActualReplyIdentity(context.model, path, comment.id, replyId, actualReplyId)
			},
		}))
}

function resolveCommentCommandArbitrary(): fc.Arbitrary<NamespaceCommand> {
	return fc
		.record({
			path: pathArbitrary('resolve'),
			author: authorArbitrary(),
		})
		.map(({ path, author }) => ({
			label: `resolveComment(${path})`,
			run(context) {
				if (!isFilePath(context.model, path)) {
					return
				}

				const comment = firstComment(context.model, path)
				if (!comment?.actualId) {
					return
				}

				modelResolveComment(context.model, path, comment.id, author)
				context.filesystem.resolveComment(path, comment.actualId, author)
			},
		}))
}

function renameCommandArbitrary(): fc.Arbitrary<NamespaceCommand> {
	return fc
		.record({
			fromPath: pathArbitrary('rename-source'),
			toPath: pathArbitrary('rename-dest'),
		})
		.map(({ fromPath, toPath }) => ({
			label: `rename(${fromPath} -> ${toPath})`,
			run(context) {
				if (
					!modelExists(context.model, fromPath) ||
					modelExists(context.model, toPath) ||
					!parentExists(context.model, toPath)
				) {
					return
				}

				if (toPath.startsWith(`${fromPath}/`)) {
					return
				}

				const existingActualEntryId = actualEntryIdForPath(context.model, fromPath)
				modelRename(context.model, fromPath, toPath)
				context.filesystem.rename(fromPath, toPath)
				const stat = context.filesystem.stat(toPath)
				bindActualEntryIdentity(context.model, toPath, existingActualEntryId ?? stat.entryId, stat.contentId)
			},
		}))
}

function deleteCommandArbitrary(): fc.Arbitrary<NamespaceCommand> {
	return pathArbitrary('delete').map((path) => ({
		label: `delete(${path})`,
		run(context) {
			if (!modelExists(context.model, path) || path === '/') {
				return
			}

			const stat = statModel(context.model, path)
			if (stat.type === 'directory' && listModel(context.model, path).length > 0) {
				return
			}

			modelDelete(context.model, path)
			context.filesystem.unlink(path)
		},
	}))
}

function assertCommentsMatchModel(context: CommandContext, path: string): void {
	const expectedComments = listModelComments(context.model, path)
	const actualComments = context.filesystem.getComments(path)

	for (const expectedComment of expectedComments) {
		expect(actualComments.some((actualComment) => actualComment.id === expectedComment.actualId)).toBe(true)
	}

	expect(actualComments).toHaveLength(expectedComments.length)

	for (const expectedComment of expectedComments) {
		const actualComment = actualComments.find((candidate) => candidate.id === expectedComment.actualId)
		expect(actualComment).toBeDefined()
		expect(actualComment?.author).toBe(expectedComment.author)
		expect(actualComment?.body).toBe(expectedComment.body)
		expect(actualComment?.resolved).toBe(expectedComment.resolved)
		expect(actualComment?.resolvedBy).toBe(expectedComment.resolved ? expectedComment.resolvedBy : undefined)
		expect(actualComment?.anchorLength).toBeGreaterThanOrEqual(0)
		expect(actualComment?.anchorIndex).toBeGreaterThanOrEqual(0)

		const actualReplies = actualComment?.replies ?? []
		expect(actualReplies).toHaveLength(expectedComment.replies.length)

		for (const expectedReply of expectedComment.replies) {
			const actualReply = actualReplies.find((candidate) => candidate.id === expectedReply.actualId)
			expect(actualReply).toBeDefined()
			expect(actualReply?.parentId).toBe(expectedComment.actualId)
			expect(actualReply?.author).toBe(expectedReply.author)
			expect(actualReply?.body).toBe(expectedReply.body)
		}
	}
}

function collectExpectedDirectories(model: NamespaceModel): Map<string, true> {
	const directories = new Map<string, true>()

	for (const [path] of model.idByPath.entries()) {
		const stat = statModel(model, path)
		if (stat.type === 'directory') {
			directories.set(path, true)
		}

		const parentPath = dirname(path)
		if (path !== '/' && modelExists(model, parentPath)) {
			directories.set(parentPath, true)
		}
	}

	return directories
}

function canCreateAtPath(model: NamespaceModel, path: string): boolean {
	if (modelExists(model, path) || !parentExists(model, path)) {
		return false
	}

	return statModel(model, dirname(path)).type === 'directory'
}

function parentExists(model: NamespaceModel, path: string): boolean {
	return modelExists(model, dirname(path))
}

function isFilePath(model: NamespaceModel, path: string): boolean {
	return modelExists(model, path) && statModel(model, path).type === 'file'
}

function firstComment(model: NamespaceModel, path: string): ModelComment | undefined {
	return listModelComments(model, path)[0]
}

function firstOpenComment(model: NamespaceModel, path: string): ModelComment | undefined {
	return listModelComments(model, path).find((comment) => !comment.resolved)
}

function anchorForContent(content: string): { index: number; length: number } | undefined {
	if (content.length === 0) {
		return undefined
	}

	const length = Math.min(3, content.length)
	const maxIndex = Math.max(0, content.length - length)
	const midpoint = Math.floor(content.length / 2)
	const index = Math.min(midpoint, maxIndex)
	return { index, length }
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

function pathArbitrary(label: string): fc.Arbitrary<string> {
	return fc.array(segmentArbitrary(label), { minLength: 1, maxLength: 3 }).map((segments) => `/${segments.join('/')}`)
}

function segmentArbitrary(label: string): fc.Arbitrary<string> {
	return fc.constantFrom(`${label}-a`, `${label}-b`, `${label}-c`, `${label}-d`)
}

function authorArbitrary(): fc.Arbitrary<string> {
	return fc.constantFrom('alice', 'bob', 'carol', 'dora')
}

function commentBodyArbitrary(): fc.Arbitrary<string> {
	return fc.string({ minLength: 1, maxLength: 16 })
}
