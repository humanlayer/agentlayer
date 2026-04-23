import { describe, expect, test } from 'bun:test'
import { type CommentAnchor, EntryNotFoundError, YjsFilesystem } from '../../src'
import { waitForDocText, waitForStateVectorSync, waitForSync } from '../util/wait-for'
import { withYjsDurableStreamFileSystems, withYjsDurableStreamServer } from './fixture'

describe('Y.js Filesystem Learning Tests', async () => {
	test('Fixture tests', async () => {
		await withYjsDurableStreamServer(async ({ dss, yjss, createProviderWithAwareness }) => {
			const { awareness: awareness1, provider: provider1 } = await createProviderWithAwareness()
			const { awareness: awareness2, provider: provider2 } = await createProviderWithAwareness()

			provider1.doc.getText('test').insert(0, 'abc')
			expect(provider1.doc.getText('test').toJSON()).toEqual('abc')
			await provider1.flush()
			await waitForSync(provider2)
			await waitForDocText(provider2.doc, 'test')
			expect(provider2.doc.getText('test').toJSON()).toEqual('abc')
		})
	})

	test('Basic Filesystem Operations', async () => {
		await withYjsDurableStreamServer(async ({ dss, yjss, createProviderWithAwareness }) => {
			const { awareness: awareness1, provider: provider1 } = await createProviderWithAwareness()
			const { awareness: awareness2, provider: provider2 } = await createProviderWithAwareness()

			const fs1 = new YjsFilesystem({ doc: provider1.doc, awareness: awareness1 })

			expect(fs1.list('/')).toBeEmpty()

			const exampleFilePath = '/example.md'
			const exampleFileContent = '# This is an example'

			expect(fs1.list('/')).toBeEmpty()
			expect(fs1.createFile(exampleFilePath, exampleFileContent)).toBeString()
			expect(fs1.readFile(exampleFilePath)).toEqual(exampleFileContent)

			// Create the FS
			const fs2 = new YjsFilesystem({ doc: provider2.doc, awareness: awareness2 })

			// technically if this resolves we know the state vectors are the same and so the
			//  fs harness _should_ be the same but worth checking
			await expect(waitForStateVectorSync(fs1.doc, fs2.doc)).resolves.toBeUndefined()

			// ensure it's there
			expect(fs2.list('/').map((e) => e.path)).toContain(exampleFilePath)
			expect(fs2.readFile(exampleFilePath)).toEqual(exampleFileContent)

			// change something on fs2 and let it sync back over
			expect(fs2.unlink(exampleFilePath)).toBeUndefined()
			expect(fs2.exists(exampleFilePath)).toBeFalse()
			expect(() => fs2.readFile(exampleFilePath)).toThrow(EntryNotFoundError)
			await expect(waitForStateVectorSync(fs1.doc, fs2.doc)).resolves.toBeUndefined()
			expect(fs1.list('/')).toBeEmpty()
			expect(fs2.list('/')).toBeEmpty()
		})
	})

	test('Basic Comment Operations', async () => {
		await withYjsDurableStreamFileSystems(async ([fs1, fs2]) => {
			// Create a file on the filesystem
			const filePath = '/README.md'
			const fileContents = '# README\nThis is an example file\n\nNothing too important here'
			const commentAnchorText = 'This is an example file'
			fs1.createFile(filePath, fileContents)
			expect(fs1.readFile(filePath)).toEqual(fileContents)

			// Create a comment on the file
			// Build the comment anchor to be on the second line
			const commentAnchor: CommentAnchor = {
				index: fileContents.indexOf(commentAnchorText),
				length: commentAnchorText.length,
			}
			const commentText = 'Are you sure?'
			const commentAuthor = 'Kyle Mistele?'

			const commentId = fs1.addComment(filePath, commentAnchor, commentText, commentAuthor)
			expect(fs1.getComments(filePath)).not.toBeEmpty()
			expect(fs1.getComments(filePath).map((c) => c.body)).toContain(commentText)
			expect(fs1.getComments(filePath).map((c) => c.author)).toContain(commentAuthor)

			// Check to ensure they are the same on fs1 and fs2
			await expect(waitForStateVectorSync(fs1.doc, fs2.doc)).resolves.toBeUndefined()

			// Make sure the comments are synced
			expect(fs1.getComments(filePath)).toEqual(fs2.getComments(filePath))

			// edit the file

			const oldText = 'README\n'
			const newText = 'README\nThis is the README for humans, not for agents\n'

			// Try a bad edit that won't be in the file
			expect(() => fs2.editFile(filePath, oldText + 'doesnotexistinfile', newText)).toThrowError()

			// Try a good edit
			expect(() => fs2.editFile(filePath, oldText, newText)).not.toThrowError()

			// Wait for it to sync across
			await expect(waitForStateVectorSync(fs1.doc, fs2.doc)).resolves.toBeUndefined()

			// Make sure the replace op was done properly
			expect(fs1.readFile(filePath)).toEqual(fileContents.replace(oldText, newText))

			// Check on the comment and ensure it's still there
			const comment = fs1
				.getComments(filePath)
				.filter((c) => c.id === commentId)
				.at(0)!
			expect(comment).toBeDefined()

			const newFileContent = fs1.readFile(filePath)
			console.log(newFileContent)

			// Assert the anchor index is differnet than the old one due to the operations
			expect(comment.anchorIndex).not.toEqual(commentAnchor.index)
			// Assert it's the same as the location of the anchor text in the new one
			expect(comment.anchorIndex).toEqual(newFileContent.indexOf(commentAnchorText))
		})
	})
})
