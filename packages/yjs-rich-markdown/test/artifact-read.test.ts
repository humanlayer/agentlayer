import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { artifactFragment, RichMarkdownArtifactStore, readArtifact } from '../src'

function syncDoc(source: Y.Doc, target: Y.Doc): void {
	Y.applyUpdate(target, Y.encodeStateAsUpdate(source))
}

describe('readArtifact', () => {
	test('returns the XML fragment string for an artifact path', () => {
		const doc = new Y.Doc()
		const store = new RichMarkdownArtifactStore(doc)

		store.createArtifact('/artifacts/plan.md')
		const heading = new Y.XmlElement('heading')
		heading.setAttribute('level', '1')
		heading.insert(0, [new Y.XmlText('Plan')])
		artifactFragment(doc, '/artifacts/plan.md').insert(0, [heading])

		expect(readArtifact(doc, '/artifacts/plan.md')).toBe('<heading level="1">Plan</heading>')
	})

	test('reads only the requested path-keyed fragment', () => {
		const doc = new Y.Doc()
		const store = new RichMarkdownArtifactStore(doc)

		store.createArtifact('/artifacts/a.md')
		store.createArtifact('/artifacts/b.md')
		artifactFragment(doc, '/artifacts/a.md').insert(0, [new Y.XmlText('Artifact A')])
		artifactFragment(doc, '/artifacts/b.md').insert(0, [new Y.XmlText('Artifact B')])

		expect(readArtifact(doc, '/artifacts/a.md')).toBe('Artifact A')
		expect(readArtifact(doc, '/artifacts/b.md')).toBe('Artifact B')
	})

	test('returns an empty string for an empty artifact fragment', () => {
		const doc = new Y.Doc()
		const store = new RichMarkdownArtifactStore(doc)

		store.createArtifact('/artifacts/empty.md')

		expect(readArtifact(doc, '/artifacts/empty.md')).toBe('')
	})

	test('returns synced fragment content after a Yjs update round trip', () => {
		const doc1 = new Y.Doc()
		const doc2 = new Y.Doc()
		const store1 = new RichMarkdownArtifactStore(doc1)

		store1.createArtifact('/artifacts/synced.md')
		artifactFragment(doc1, '/artifacts/synced.md').insert(0, [new Y.XmlText('Synced content')])

		syncDoc(doc1, doc2)

		expect(readArtifact(doc2, '/artifacts/synced.md')).toBe('Synced content')
	})
})
