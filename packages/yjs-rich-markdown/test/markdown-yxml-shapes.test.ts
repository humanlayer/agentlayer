import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { RichMarkdownArtifactStore, writeArtifactMarkdown } from '../src'

function xmlFor(markdown: string): string {
	const doc = new Y.Doc()
	const store = new RichMarkdownArtifactStore(doc)
	const path = '/artifacts/shapes.md'
	store.createArtifact(path)
	writeArtifactMarkdown(doc, path, markdown)
	return store.getFragment(path).toString()
}

describe('Markdown to YXml shapes', () => {
	test('headings', () => {
		expect(xmlFor('# H1\n\n## H2\n\n### H3')).toBe(
			'<heading level="1">H1</heading><heading level="2">H2</heading><heading level="3">H3</heading>',
		)
	})

	test('paragraph with inline marks', () => {
		expect(xmlFor('Plain **bold** *italic* `code` [link](https://example.com).')).toBe(
			'<paragraph>Plain <bold>bold</bold> <italic>italic</italic> <code>code</code> <link class="null" href="https://example.com" rel="noopener noreferrer nofollow" target="_blank" title="null">link</link>.</paragraph>',
		)
	})

	test('unordered and ordered lists', () => {
		expect(xmlFor('- First\n- Second\n\n1. One\n2. Two')).toBe(
			'<bulletlist><listitem><paragraph>First</paragraph></listitem><listitem><paragraph>Second</paragraph></listitem></bulletlist><orderedlist start="1"><listitem><paragraph>One</paragraph></listitem><listitem><paragraph>Two</paragraph></listitem></orderedlist>',
		)
	})

	test('nested unordered list', () => {
		expect(xmlFor('- Parent\n  - Child')).toBe(
			'<bulletlist><listitem><paragraph>Parent</paragraph><bulletlist><listitem><paragraph>Child</paragraph></listitem></bulletlist></listitem></bulletlist>',
		)
	})

	test('blockquote', () => {
		expect(xmlFor('> Quote line')).toBe('<blockquote><paragraph>Quote line</paragraph></blockquote>')
	})

	test('horizontal rule', () => {
		expect(xmlFor('Before\n\n---\n\nAfter')).toBe(
			'<paragraph>Before</paragraph><horizontalrule></horizontalrule><paragraph>After</paragraph>',
		)
	})

	test('hard break inside paragraph', () => {
		expect(xmlFor('First line\\\nSecond line')).toBe(
			'<paragraph>First line<hardbreak></hardbreak>Second line</paragraph>',
		)
	})

	test('single-line fenced code block', () => {
		expect(xmlFor('```ts\nconst value = 1\n```')).toBe('<codeblock language="ts">const value = 1</codeblock>')
	})

	test('multi-line fenced code block', () => {
		expect(xmlFor('```ts\nconst value = 1\nconsole.log(value)\n```')).toBe(
			'<codeblock language="ts">const value = 1\nconsole.log(value)</codeblock>',
		)
	})

	test('indented code block', () => {
		expect(xmlFor('    const value = 1\n    console.log(value)')).toBe(
			'<codeblock>const value = 1\nconsole.log(value)</codeblock>',
		)
	})

	test('strikethrough', () => {
		expect(xmlFor('~~deleted~~')).toBe('<paragraph><strike>deleted</strike></paragraph>')
	})
})
