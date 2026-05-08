import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { YXmlProxyBindings } from '../src'

describe('YXML proxy prompt examples', () => {
	test('add a paragraph after the first top-level node', () => {
		const proxy = createPromptExampleProxy()

		const beforeXml = proxy.toString({})
		expect(beforeXml).toContain('<heading level="2">Original Heading</heading>')

		const first = proxy.get({ index: 0 })
		proxy.insertAfter({
			ref: first,
			content: [
				{
					kind: 'element',
					nodeName: 'paragraph',
					children: [{ kind: 'text', text: 'Added paragraph.' }],
				},
			],
		})

		expect(proxy.toString({})).toBe(
			'<heading level="2">Original Heading</heading><paragraph>Added paragraph.</paragraph><paragraph>Original paragraph.</paragraph><bulletlist><listitem><paragraph>Use scoped NodeRefs.</paragraph></listitem><listitem><paragraph>Validate after mutation.</paragraph></listitem></bulletlist><section id="obsolete"><paragraph>Remove me.</paragraph></section>',
		)
	})

	test('add a new section containing a heading, paragraph, list, blockquote, horizontal rule, and code block', () => {
		const proxy = createPromptExampleProxy()

		proxy.append({
			content: [
				{
					kind: 'element',
					nodeName: 'heading',
					attributes: { level: '2' },
					children: [{ kind: 'text', text: 'Implementation Notes' }],
				},
				{
					kind: 'element',
					nodeName: 'paragraph',
					children: [
						{ kind: 'text', text: 'The agent edits through ' },
						{ kind: 'element', nodeName: 'code', children: [{ kind: 'text', text: 'bindings' }] },
						{ kind: 'text', text: ' instead of direct Yjs objects.' },
					],
				},
				{
					kind: 'element',
					nodeName: 'bulletList',
					children: [
						{
							kind: 'element',
							nodeName: 'listItem',
							children: [
								{
									kind: 'element',
									nodeName: 'paragraph',
									children: [{ kind: 'text', text: 'Use scoped NodeRefs.' }],
								},
							],
						},
						{
							kind: 'element',
							nodeName: 'listItem',
							children: [
								{
									kind: 'element',
									nodeName: 'paragraph',
									children: [{ kind: 'text', text: 'Validate after mutation.' }],
								},
							],
						},
					],
				},
				{
					kind: 'element',
					nodeName: 'blockquote',
					children: [
						{
							kind: 'element',
							nodeName: 'paragraph',
							children: [{ kind: 'text', text: 'Bindings keep generated code sandbox-safe.' }],
						},
					],
				},
				{ kind: 'element', nodeName: 'horizontalRule' },
				{
					kind: 'element',
					nodeName: 'codeBlock',
					attributes: { language: 'ts' },
					children: [
						{ kind: 'text', text: 'const root = bindings.root()\nconst xml = bindings.toString({})' },
					],
				},
			],
		})

		expect(proxy.toString({})).toContain('<heading level="2">Implementation Notes</heading>')
		expect(proxy.toString({})).toContain(
			'<paragraph>The agent edits through <code>bindings</code> instead of direct Yjs objects.</paragraph>',
		)
		expect(proxy.toString({})).toContain(
			'<blockquote><paragraph>Bindings keep generated code sandbox-safe.</paragraph></blockquote>',
		)
		expect(proxy.toString({})).toContain('<horizontalrule></horizontalrule>')
		expect(proxy.toString({})).toContain(
			'<codeblock language="ts">const root = bindings.root()\nconst xml = bindings.toString({})</codeblock>',
		)
	})

	test('add a bullet to an existing list', () => {
		const proxy = createPromptExampleProxy()

		const rootChildren = proxy.children({})
		const list = rootChildren.find((node) => proxy.summary({ node }).nodeName === 'bulletList')
		if (!list) throw new Error('Could not find a bullet list')

		proxy.append({
			parent: list,
			content: [
				{
					kind: 'element',
					nodeName: 'listItem',
					children: [
						{
							kind: 'element',
							nodeName: 'paragraph',
							children: [{ kind: 'text', text: 'New bullet' }],
						},
					],
				},
			],
		})

		expect(proxy.toString({})).toContain(
			'<bulletlist><listitem><paragraph>Use scoped NodeRefs.</paragraph></listitem><listitem><paragraph>Validate after mutation.</paragraph></listitem><listitem><paragraph>New bullet</paragraph></listitem></bulletlist>',
		)
	})

	test('change a heading level attribute', () => {
		const proxy = createPromptExampleProxy()

		const heading = proxy.children({}).find((node) => proxy.summary({ node }).nodeName === 'heading')
		if (!heading) throw new Error('Could not find a heading')

		proxy.setAttribute({ node: heading, name: 'level', value: '3' })

		expect(proxy.summary({ node: heading }).attributes).toEqual({ level: '3' })
		expect(proxy.toString({})).toContain('<heading level="3">Original Heading</heading>')
	})

	test('erase a section', () => {
		const proxy = createPromptExampleProxy()

		const section = proxy.children({}).find((node) => {
			const summary = proxy.summary({ node })
			return summary.nodeName === 'section' && summary.attributes?.id === 'obsolete'
		})
		if (!section) throw new Error('Could not find obsolete section')

		proxy.remove({ node: section })

		expect(proxy.toString({})).not.toContain('<section id="obsolete">')
		expect(proxy.toString({})).toBe(
			'<heading level="2">Original Heading</heading><paragraph>Original paragraph.</paragraph><bulletlist><listitem><paragraph>Use scoped NodeRefs.</paragraph></listitem><listitem><paragraph>Validate after mutation.</paragraph></listitem></bulletlist>',
		)
	})

	test('wrap existing deeply nested text in a bold mark', () => {
		const proxy = createPromptExampleProxy()

		const list = proxy.children({}).find((node) => proxy.summary({ node }).nodeName === 'bulletList')
		if (!list) throw new Error('Could not find a bullet list')
		const secondItem = proxy.get({ node: list, index: 1 })
		const paragraph = proxy.get({ node: secondItem, index: 0 })
		const text = proxy.children({ node: paragraph }).find((node) => proxy.summary({ node }).kind === 'text')
		if (!text) throw new Error('Could not find text to bold')

		proxy.wrap({ node: text, wrapper: { nodeName: 'bold' } })

		expect(proxy.toString({})).toContain(
			'<listitem><paragraph><bold>Validate after mutation.</bold></paragraph></listitem>',
		)
	})

	test('wrap only one word inside an interleaved text node', () => {
		const proxy = createInterleavedExampleProxy()

		const example = proxy.children({}).find((node) => proxy.summary({ node }).nodeName === 'example')
		if (!example) throw new Error('Could not find example element')
		const firstChild = proxy.get({ node: example, index: 0 })
		const firstText = proxy.text({ node: firstChild })
		const start = firstText.indexOf('example')
		if (start < 0) throw new Error('Could not find target word')

		proxy.wrapTextRange({
			node: firstChild,
			start,
			end: start + 'example'.length,
			wrapper: { nodeName: 'bold' },
		})

		expect(proxy.toString({})).toBe(
			'<example>this is an <bold>example</bold> <nestedexample>this is a nested example</nestedexample> This is another example</example>',
		)
	})

	test('wrap one word inside text that already lives under an inline mark', () => {
		const proxy = createInlineMarkedExampleProxy()

		const paragraph = proxy.children({}).find((node) => proxy.summary({ node }).nodeName === 'paragraph')
		if (!paragraph) throw new Error('Could not find paragraph')
		const italic = proxy.children({ node: paragraph }).find((node) => proxy.summary({ node }).nodeName === 'italic')
		if (!italic) throw new Error('Could not find italic mark')
		const italicTextNode = proxy.children({ node: italic }).find((node) => proxy.summary({ node }).kind === 'text')
		if (!italicTextNode) throw new Error('Could not find italic text node')

		const italicText = proxy.text({ node: italicTextNode })
		const start = italicText.indexOf('example')
		if (start < 0) throw new Error('Could not find target word')

		proxy.wrapTextRange({
			node: italicTextNode,
			start,
			end: start + 'example'.length,
			wrapper: { nodeName: 'bold' },
		})

		expect(proxy.toString({})).toBe(
			'<paragraph>Before <italic>nested <bold>example</bold> text</italic> after</paragraph>',
		)
	})
})

function createPromptExampleProxy(): YXmlProxyBindings {
	const doc = new Y.Doc()
	const fragment = doc.getXmlFragment('artifact')
	seedPromptExampleDocument(fragment)
	return new YXmlProxyBindings(fragment)
}

function createInterleavedExampleProxy(): YXmlProxyBindings {
	const doc = new Y.Doc()
	const fragment = doc.getXmlFragment('artifact')
	const example = new Y.XmlElement('example')
	example.insert(0, [
		text('this is an example '),
		createElement('nestedExample', [text('this is a nested example')]),
		text(' This is another example'),
	])
	fragment.insert(0, [example])
	return new YXmlProxyBindings(fragment)
}

function createInlineMarkedExampleProxy(): YXmlProxyBindings {
	const doc = new Y.Doc()
	const fragment = doc.getXmlFragment('artifact')
	const paragraph = new Y.XmlElement('paragraph')
	paragraph.insert(0, [text('Before '), createElement('italic', [text('nested example text')]), text(' after')])
	fragment.insert(0, [paragraph])
	return new YXmlProxyBindings(fragment)
}

function seedPromptExampleDocument(fragment: Y.XmlFragment): void {
	const heading = new Y.XmlElement('heading')
	heading.setAttribute('level', '2')
	heading.insert(0, [text('Original Heading')])

	const paragraph = new Y.XmlElement('paragraph')
	paragraph.insert(0, [text('Original paragraph.')])

	const list = new Y.XmlElement('bulletList')
	list.insert(0, [listItem('Use scoped NodeRefs.'), listItem('Validate after mutation.')])

	const section = new Y.XmlElement('section')
	section.setAttribute('id', 'obsolete')
	const sectionParagraph = new Y.XmlElement('paragraph')
	sectionParagraph.insert(0, [text('Remove me.')])
	section.insert(0, [sectionParagraph])

	fragment.insert(0, [heading, paragraph, list, section])
}

function listItem(value: string): Y.XmlElement {
	const item = new Y.XmlElement('listItem')
	const paragraph = new Y.XmlElement('paragraph')
	paragraph.insert(0, [text(value)])
	item.insert(0, [paragraph])
	return item
}

function createElement(name: string, children: Array<Y.XmlElement | Y.XmlText>): Y.XmlElement {
	const element = new Y.XmlElement(name)
	element.insert(0, children)
	return element
}

function text(value: string): Y.XmlText {
	const xmlText = new Y.XmlText()
	xmlText.insert(0, value)
	return xmlText
}
