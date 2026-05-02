import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { RichMarkdownArtifactStore, readArtifactMarkdown, writeArtifactMarkdown } from '../src'

function syncDoc(source: Y.Doc, target: Y.Doc): void {
	Y.applyUpdate(target, Y.encodeStateAsUpdate(source))
}

describe('markdown artifact bridge', () => {
	test('writes markdown into a Yjs TipTap fragment and reads it back as markdown', () => {
		const doc = new Y.Doc()
		const store = new RichMarkdownArtifactStore(doc)

		store.createArtifact('/artifacts/plan.md')
		writeArtifactMarkdown(doc, '/artifacts/plan.md', '# Plan\n\nThis is **bold** and *useful*.')

		expect(store.getFragment('/artifacts/plan.md').toString()).toBe(
			'<heading level="1">Plan</heading><paragraph>This is <bold>bold</bold> and <italic>useful</italic>.</paragraph>',
		)
		expect(readArtifactMarkdown(doc, '/artifacts/plan.md')).toBe('# Plan\n\nThis is **bold** and *useful*.')
	})

	test('round trips representative markdown blocks and marks', () => {
		const doc = new Y.Doc()
		const store = new RichMarkdownArtifactStore(doc)
		const markdown = [
			'# Title',
			'',
			'Paragraph with **bold**, *italic*, `code`, and [a link](https://example.com).',
			'',
			'- First',
			'- Second',
			'',
			'1. One',
			'2. Two',
			'',
			'> A quote',
			'',
			'```ts',
			'const value = 1',
			'```',
		].join('\n')

		store.createArtifact('/artifacts/rich.md')
		writeArtifactMarkdown(doc, '/artifacts/rich.md', markdown)

		expect(readArtifactMarkdown(doc, '/artifacts/rich.md')).toBe(markdown)
	})

	test('keeps markdown writes isolated by artifact path', () => {
		const doc = new Y.Doc()
		const store = new RichMarkdownArtifactStore(doc)

		store.createArtifact('/artifacts/a.md')
		store.createArtifact('/artifacts/b.md')
		writeArtifactMarkdown(doc, '/artifacts/a.md', '# A')
		writeArtifactMarkdown(doc, '/artifacts/b.md', '# B')

		expect(readArtifactMarkdown(doc, '/artifacts/a.md')).toBe('# A')
		expect(readArtifactMarkdown(doc, '/artifacts/b.md')).toBe('# B')
	})

	test('reads markdown after a Yjs update sync round trip', () => {
		const doc1 = new Y.Doc()
		const doc2 = new Y.Doc()
		const store1 = new RichMarkdownArtifactStore(doc1)

		store1.createArtifact('/artifacts/synced.md')
		writeArtifactMarkdown(doc1, '/artifacts/synced.md', '## Synced\n\nShared content.')
		syncDoc(doc1, doc2)

		expect(readArtifactMarkdown(doc2, '/artifacts/synced.md')).toBe('## Synced\n\nShared content.')
	})

	test('write replaces existing fragment content from markdown', () => {
		const doc = new Y.Doc()
		const store = new RichMarkdownArtifactStore(doc)

		store.createArtifact('/artifacts/rewrite.md')
		writeArtifactMarkdown(doc, '/artifacts/rewrite.md', '# Old')
		writeArtifactMarkdown(doc, '/artifacts/rewrite.md', '# New\n\nReplacement.')

		expect(readArtifactMarkdown(doc, '/artifacts/rewrite.md')).toBe('# New\n\nReplacement.')
		expect(store.getFragment('/artifacts/rewrite.md').toString()).toBe(
			'<heading level="1">New</heading><paragraph>Replacement.</paragraph>',
		)
	})
})
