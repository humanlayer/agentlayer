import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { artifactFragment, artifactFragmentName, RichMarkdownArtifactStore } from '../src'

function syncDoc(source: Y.Doc, target: Y.Doc): void {
	Y.applyUpdate(target, Y.encodeStateAsUpdate(source))
}

describe('rich markdown artifact fragments', () => {
	test('stores multiple artifact fragments in one Y.Doc without cross-contamination', () => {
		const doc1 = new Y.Doc()
		const doc2 = new Y.Doc()
		const store1 = new RichMarkdownArtifactStore(doc1)
		const store2 = new RichMarkdownArtifactStore(doc2)

		store1.createArtifact('/artifacts/a.md', { now: 1, title: 'A' })
		store1.createArtifact('/artifacts/b.md', { now: 2, title: 'B' })

		artifactFragment(doc1, '/artifacts/a.md').insert(0, [new Y.XmlText('Artifact A')])
		artifactFragment(doc1, '/artifacts/b.md').insert(0, [new Y.XmlText('Artifact B')])

		syncDoc(doc1, doc2)

		expect(store2.listArtifacts().map((artifact) => artifact.path)).toEqual(['/artifacts/a.md', '/artifacts/b.md'])
		expect(artifactFragment(doc2, '/artifacts/a.md').toString()).toBe('Artifact A')
		expect(artifactFragment(doc2, '/artifacts/b.md').toString()).toBe('Artifact B')
		expect(doc2.getXmlFragment(artifactFragmentName('/artifacts/a.md'))).not.toBe(
			doc2.getXmlFragment(artifactFragmentName('/artifacts/b.md')),
		)
	})
})
