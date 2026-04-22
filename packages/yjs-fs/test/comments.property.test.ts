import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import { YjsFilesystem } from '@humanlayer/yjs-fs'

const PROPERTY_SEED = 840251

type Operation =
	| { kind: 'editPrefix'; text: string }
	| { kind: 'editMiddle'; text: string }
	| { kind: 'editSuffix'; text: string }
	| { kind: 'writeFile'; content: string }
	| { kind: 'addComment'; body: string; author: string }
	| { kind: 'replyToComment'; body: string; author: string }
	| { kind: 'resolveComment'; author: string }

const BASE_CONTENT = 'alpha beta gamma delta'

describe('YjsFilesystem comment properties', () => {
	test('comment operations preserve anchors and unrelated metadata under edit interleavings', () => {
		fc.assert(
			fc.property(fc.array(operationArbitrary(), { minLength: 1, maxLength: 40 }), (operations) => {
				const filesystem = createFilesystem()
				let lastStat = filesystem.stat('/workspace/note.txt')

				for (const operation of operations) {
					applyOperation(filesystem, operation)
					const stat = filesystem.stat('/workspace/note.txt')
					const content = filesystem.readFile('/workspace/note.txt')
					const comments = filesystem.getComments('/workspace/note.txt')

					expect(stat.entryId).toBe(lastStat.entryId)
					expect(stat.contentId).toBe(lastStat.contentId)
					expect(stat.size).toBe(content.length)

					for (const comment of comments) {
						expect(comment.anchorIndex).toBeGreaterThanOrEqual(0)
						expect(comment.anchorLength).toBeGreaterThanOrEqual(0)
						expect(comment.anchorIndex + comment.anchorLength).toBeLessThanOrEqual(content.length)
						expect(comment.body.length).toBeGreaterThan(0)
						for (const reply of comment.replies) {
							expect(reply.parentId).toBe(comment.id)
							expect(reply.body.length).toBeGreaterThan(0)
						}
					}

					lastStat = stat
				}
			}),
			{
				seed: PROPERTY_SEED,
				numRuns: 100,
				verbose: 2,
			},
		)
	})
})

function createFilesystem(): YjsFilesystem {
	const filesystem = new YjsFilesystem()
	filesystem.mkdir('/workspace')
	filesystem.createFile('/workspace/note.txt', BASE_CONTENT)
	return filesystem
}

function applyOperation(filesystem: YjsFilesystem, operation: Operation): void {
	switch (operation.kind) {
		case 'editPrefix': {
			filesystem.writeFile('/workspace/note.txt', `${operation.text}${BASE_CONTENT}`)
			break
		}
		case 'editMiddle': {
			filesystem.writeFile('/workspace/note.txt', BASE_CONTENT.replace('beta', `${operation.text}beta${operation.text}`))
			break
		}
		case 'editSuffix': {
			filesystem.writeFile('/workspace/note.txt', `${BASE_CONTENT}${operation.text}`)
			break
		}
		case 'writeFile': {
			const content = operation.content.length > 0 ? operation.content : BASE_CONTENT
			filesystem.writeFile('/workspace/note.txt', content)
			break
		}
		case 'addComment': {
			const content = filesystem.readFile('/workspace/note.txt')
			if (content.length === 0) {
				break
			}

			const anchorLength = Math.min(5, content.length)
			const anchorIndex = Math.max(0, Math.floor((content.length - anchorLength) / 2))
			filesystem.addComment(
				'/workspace/note.txt',
				{ index: anchorIndex, length: anchorLength },
				operation.body,
				operation.author,
			)
			break
		}
		case 'replyToComment': {
			const comment = filesystem.getComments('/workspace/note.txt').find((candidate) => !candidate.resolved)
			if (!comment) {
				break
			}

			filesystem.replyToComment('/workspace/note.txt', comment.id, operation.body, operation.author)
			break
		}
		case 'resolveComment': {
			const comment = filesystem.getComments('/workspace/note.txt')[0]
			if (!comment) {
				break
			}

			filesystem.resolveComment('/workspace/note.txt', comment.id, operation.author)
			break
		}
	}
}

function operationArbitrary(): fc.Arbitrary<Operation> {
	return fc.oneof(
		fc.string({ maxLength: 8 }).map((text) => ({ kind: 'editPrefix' as const, text })),
		fc.string({ maxLength: 6 }).map((text) => ({ kind: 'editMiddle' as const, text })),
		fc.string({ maxLength: 8 }).map((text) => ({ kind: 'editSuffix' as const, text })),
		fc.string({ minLength: 1, maxLength: 24 }).map((content) => ({ kind: 'writeFile' as const, content })),
		fc.record({ body: fc.string({ minLength: 1, maxLength: 20 }), author: authorArbitrary() }).map(({ body, author }) => ({
			kind: 'addComment' as const,
			body,
			author,
		})),
		fc.record({ body: fc.string({ minLength: 1, maxLength: 20 }), author: authorArbitrary() }).map(({ body, author }) => ({
			kind: 'replyToComment' as const,
			body,
			author,
		})),
		authorArbitrary().map((author) => ({ kind: 'resolveComment' as const, author })),
	)
}

function authorArbitrary(): fc.Arbitrary<string> {
	return fc.constantFrom('alice', 'bob', 'carol', 'dora')
}
