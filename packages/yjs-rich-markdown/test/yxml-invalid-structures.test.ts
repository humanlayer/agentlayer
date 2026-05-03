import { describe, expect, test } from 'bun:test'
import type { JSONContent } from '@tiptap/core'
import * as Y from 'yjs'
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror'
import { markdownToTiptapJson, tiptapJsonToMarkdown } from '../src'

function text(value: string): Y.XmlText {
	const node = new Y.XmlText()
	node.insert(0, value)
	return node
}

function element(nodeName: string, children: Array<Y.XmlElement | Y.XmlText> = []): Y.XmlElement {
	const node = new Y.XmlElement(nodeName)
	if (children.length > 0) node.insert(0, children)
	return node
}

function jsonFor(fragment: Y.XmlFragment): JSONContent {
	return yXmlFragmentToProsemirrorJSON(fragment) as JSONContent
}

describe('invalid or lossy YXml structures', () => {
	test('unsupported block node type survives YXml but is dropped during markdown serialization', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('invalid')
		fragment.insert(0, [element('madeupblock', [text('Unknown block')])])

		expect(fragment.toString()).toBe('<madeupblock>Unknown block</madeupblock>')
		expect(jsonFor(fragment)).toEqual({
			type: 'doc',
			content: [{ type: 'madeupblock', content: [{ type: 'text', text: 'Unknown block' }] }],
		})
		expect(tiptapJsonToMarkdown(jsonFor(fragment))).toBe('')
	})

	test('unsupported nested node type survives YXml but is dropped during markdown serialization', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('invalid')
		fragment.insert(0, [element('paragraph', [text('Before '), element('custommark', [text('marked')]), text(' after')])])

		expect(fragment.toString()).toBe('<paragraph>Before <custommark>marked</custommark> after</paragraph>')
		expect(jsonFor(fragment)).toEqual({
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: 'Before ' },
						{ type: 'custommark', content: [{ type: 'text', text: 'marked' }] },
						{ type: 'text', text: ' after' },
					],
				},
			],
		})
		expect(tiptapJsonToMarkdown(jsonFor(fragment))).toBe('Before  after')
	})

	test('schema-invalid paragraph nesting converts to JSON and flattens during markdown serialization', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('invalid')
		fragment.insert(0, [element('paragraph', [element('paragraph', [text('Nested paragraph')])])])

		expect(fragment.toString()).toBe('<paragraph><paragraph>Nested paragraph</paragraph></paragraph>')
		expect(jsonFor(fragment)).toEqual({
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested paragraph' }] }],
				},
			],
		})
		expect(tiptapJsonToMarkdown(jsonFor(fragment))).toBe('Nested paragraph')
	})

	test('whitespace in paragraphs is preserved by markdown round trip', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('whitespace')
		fragment.insert(0, [element('paragraph', [text('one   two')])])

		const markdown = tiptapJsonToMarkdown(jsonFor(fragment))
		const reparsedMarkdown = tiptapJsonToMarkdown(markdownToTiptapJson(markdown))

		expect(markdown).toBe('one   two')
		expect(reparsedMarkdown).toBe('one   two')
	})

	test('whitespace in fenced code blocks is preserved by markdown round trip', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('code')
		const code = element('codeBlock', [text('const  value = 1\n  console.log(value)')])
		code.setAttribute('language', 'ts')
		fragment.insert(0, [code])

		const markdown = tiptapJsonToMarkdown(jsonFor(fragment))
		const reparsedMarkdown = tiptapJsonToMarkdown(markdownToTiptapJson(markdown))

		expect(markdown).toBe('```ts\nconst  value = 1\n  console.log(value)\n```')
		expect(reparsedMarkdown).toBe(markdown)
	})
})
