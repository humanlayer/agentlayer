import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import {
	DetachedYXmlNodeRefError,
	UnknownYXmlNodeRefError,
	YXmlChildIndexOutOfBoundsError,
	YXmlInvalidNodeKindForOperationError,
	YXmlNodeRefKindMismatchError,
	YXmlProxyBindings,
	YXmlRootOperationError,
	YXmlTextRangeOutOfBoundsError,
} from '../src'

describe('YXml proxy', () => {
	test('appends XML elements and nested children', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const inserted = proxy.append({
			content: [
				{
					kind: 'element',
					nodeName: 'section',
					attributes: { id: 'intro' },
					children: [
						{
							kind: 'element',
							nodeName: 'heading',
							attributes: { level: '2' },
							children: [{ kind: 'text', text: 'Intro' }],
						},
						{
							kind: 'element',
							nodeName: 'paragraph',
							children: [{ kind: 'text', text: 'Nested content works.' }],
						},
					],
				},
			],
		})

		expect(inserted).toEqual([{ id: expect.any(String), kind: 'element' }])
		expect(proxy.toString()).toBe(
			'<section id="intro"><heading level="2">Intro</heading><paragraph>Nested content works.</paragraph></section>',
		)
	})

	test('exposes bound bindings for host environments like QuickJS', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		expect(proxy.bindings).not.toBe(proxy)
		expect(proxy.bindings.root?.()).toEqual(proxy.root())

		proxy.bindings.append?.({
			content: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Via bindings' }] }],
		})

		expect(proxy.bindings.toString?.()).toBe('<paragraph>Via bindings</paragraph>')
		expect(proxy.toString()).toBe('<paragraph>Via bindings</paragraph>')
	})

	test('inserts before and after refs without passing parent', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [middle] = proxy.append({
			content: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Middle' }] }],
		})
		if (!middle) throw new Error('Expected middle node')

		proxy.insertBefore({
			ref: middle,
			content: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Before' }] }],
		})
		proxy.insertAfter({
			ref: middle,
			content: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'After' }] }],
		})

		expect(proxy.toString()).toBe(
			'<paragraph>Before</paragraph><paragraph>Middle</paragraph><paragraph>After</paragraph>',
		)
	})

	test('appends nested content inside an element parent', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [list] = proxy.append({ content: [{ kind: 'element', nodeName: 'bulletList' }] })
		if (!list) throw new Error('Expected list node')

		proxy.append({
			parent: list,
			content: [
				{
					kind: 'element',
					nodeName: 'listItem',
					children: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'First' }] }],
				},
				{
					kind: 'element',
					nodeName: 'listItem',
					children: [
						{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Second' }] },
					],
				},
			],
		})

		expect(proxy.toString()).toBe(
			'<bulletlist><listitem><paragraph>First</paragraph></listitem><listitem><paragraph>Second</paragraph></listitem></bulletlist>',
		)
		expect(proxy.summary({ node: list }).nodeName).toBe('bulletList')
	})

	test('reads interleaved text and element children inside an element', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [example] = proxy.append({
			content: [
				{
					kind: 'element',
					nodeName: 'example',
					children: [
						{ kind: 'text', text: 'this is an example ' },
						{ kind: 'element', nodeName: 'nestedExample', children: [{ kind: 'text', text: 'this is a nested example' }] },
						{ kind: 'text', text: ' This is another example' },
					],
				},
			],
		})
		if (!example) throw new Error('Expected example node')

		const children = proxy.children({ node: example })
		const [firstText, nestedExample, secondText] = children
		if (!firstText || !nestedExample || !secondText) throw new Error('Expected interleaved children')

		expect(children.map((node) => proxy.summary({ node }).kind)).toEqual(['text', 'element', 'text'])
		expect(proxy.text({ node: firstText })).toBe('this is an example ')
		expect(proxy.summary({ node: nestedExample }).nodeName).toBe('nestedExample')
		expect(proxy.text({ node: secondText })).toBe(' This is another example')
	})

	test('edits text inside an interleaved text node', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [example] = proxy.append({
			content: [
				{
					kind: 'element',
					nodeName: 'example',
					children: [
						{ kind: 'text', text: 'this is an example ' },
						{ kind: 'element', nodeName: 'nestedExample', children: [{ kind: 'text', text: 'this is a nested example' }] },
						{ kind: 'text', text: ' This is another example' },
					],
				},
			],
		})
		if (!example) throw new Error('Expected example node')
		const [firstText, nestedExample, secondText] = proxy.children({ node: example })
		if (!firstText || !nestedExample || !secondText) throw new Error('Expected interleaved children')

		proxy.insertText({ node: firstText, index: 0, text: 'Actually, ' })
		proxy.deleteText({ node: secondText, index: 0, length: 9 })

		expect(proxy.text({ node: firstText })).toBe('Actually, this is an example ')
		expect(proxy.text({ node: secondText })).toBe('another example')
		expect(proxy.toString()).toBe(
			'<example>Actually, this is an example <nestedexample>this is a nested example</nestedexample>another example</example>',
		)
	})

	test('splits a text node into interleaved siblings', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [example] = proxy.append({
			content: [
				{ kind: 'element', nodeName: 'example', children: [{ kind: 'text', text: 'this is an example' }] },
			],
		})
		if (!example) throw new Error('Expected example node')
		const [textNode] = proxy.children({ node: example })
		if (!textNode) throw new Error('Expected text node')

		const split = proxy.splitText({ node: textNode, index: 8 })

		expect(proxy.text({ node: split.left })).toBe('this is ')
		expect(proxy.text({ node: split.right })).toBe('an example')
		expect(proxy.children({ node: example })).toEqual([split.left, split.right])
	})

	test('wraps only part of a text node while preserving interleaved siblings', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [example] = proxy.append({
			content: [
				{
					kind: 'element',
					nodeName: 'example',
					children: [
						{ kind: 'text', text: 'this is an example ' },
						{ kind: 'element', nodeName: 'nestedExample', children: [{ kind: 'text', text: 'this is a nested example' }] },
						{ kind: 'text', text: ' This is another example' },
					],
				},
			],
		})
		if (!example) throw new Error('Expected example node')
		const [firstText, nestedExample, secondText] = proxy.children({ node: example })
		if (!firstText || !nestedExample || !secondText) throw new Error('Expected interleaved children')

		const wrapped = proxy.wrapTextRange({ node: firstText, start: 11, end: 18, wrapper: { nodeName: 'bold' } })

		const children = proxy.children({ node: example })
		const [beforeText, boldNode, afterText, sameNestedExample, sameSecondText] = children
		if (!beforeText || !boldNode || !afterText || !sameNestedExample || !sameSecondText) throw new Error('Expected wrapped children')

		expect(proxy.text({ node: beforeText })).toBe('this is an ')
		expect(proxy.toString({ node: boldNode })).toBe('<bold>example</bold>')
		expect(proxy.text({ node: afterText })).toBe(' ')
		expect(sameNestedExample).toEqual(nestedExample)
		expect(sameSecondText).toEqual(secondText)
		expect(wrapped.wrapper).toEqual(boldNode)
		expect(proxy.toString()).toBe(
			'<example>this is an <bold>example</bold> <nestedexample>this is a nested example</nestedexample> This is another example</example>',
		)
	})

	test('wraps part of text inside an already marked inline element', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [paragraph] = proxy.append({
			content: [
				{
					kind: 'element',
					nodeName: 'paragraph',
					children: [
						{ kind: 'text', text: 'prefix ' },
						{ kind: 'element', nodeName: 'italic', children: [{ kind: 'text', text: 'nested example text' }] },
						{ kind: 'text', text: ' suffix' },
					],
				},
			],
		})
		if (!paragraph) throw new Error('Expected paragraph node')

		const [, italic, suffix] = proxy.children({ node: paragraph })
		if (!italic || !suffix) throw new Error('Expected italic and suffix nodes')
		const [italicText] = proxy.children({ node: italic })
		if (!italicText) throw new Error('Expected italic text node')

		const wrapped = proxy.wrapTextRange({
			node: italicText,
			start: 7,
			end: 14,
			wrapper: { nodeName: 'bold' },
		})

		const italicChildren = proxy.children({ node: italic })
		const [beforeText, boldNode, afterText] = italicChildren
		if (!beforeText || !boldNode || !afterText) throw new Error('Expected split italic children')

		expect(proxy.text({ node: beforeText })).toBe('nested ')
		expect(proxy.toString({ node: boldNode })).toBe('<bold>example</bold>')
		expect(proxy.text({ node: afterText })).toBe(' text')
		expect(wrapped.wrapper).toEqual(boldNode)
		expect(proxy.toString({ node: italic })).toBe('<italic>nested <bold>example</bold> text</italic>')
		expect(proxy.text({ node: suffix })).toBe(' suffix')
		expect(proxy.toString()).toBe(
			'<paragraph>prefix <italic>nested <bold>example</bold> text</italic> suffix</paragraph>',
		)
	})

	test('can combine splitText and wrapTextRange inside an existing inline mark', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [paragraph] = proxy.append({
			content: [
				{
					kind: 'element',
					nodeName: 'paragraph',
					children: [
						{ kind: 'element', nodeName: 'italic', children: [{ kind: 'text', text: 'alpha beta gamma' }] },
					],
				},
			],
		})
		if (!paragraph) throw new Error('Expected paragraph node')

		const [italic] = proxy.children({ node: paragraph })
		if (!italic) throw new Error('Expected italic node')
		const [italicText] = proxy.children({ node: italic })
		if (!italicText) throw new Error('Expected italic text node')

		const firstSplit = proxy.splitText({ node: italicText, index: 6 })
		expect(proxy.text({ node: firstSplit.left })).toBe('alpha ')
		expect(proxy.text({ node: firstSplit.right })).toBe('beta gamma')

		const secondSplit = proxy.splitText({ node: firstSplit.right, index: 4 })
		expect(proxy.text({ node: secondSplit.left })).toBe('beta')
		expect(proxy.text({ node: secondSplit.right })).toBe(' gamma')

		proxy.wrap({ node: secondSplit.left, wrapper: { nodeName: 'bold' } })

		expect(proxy.toString({ node: italic })).toBe('<italic>alpha <bold>beta</bold> gamma</italic>')
		expect(proxy.toString()).toBe('<paragraph><italic>alpha <bold>beta</bold> gamma</italic></paragraph>')
	})

	test('can edit adjacent to a new bold node inside an existing inline mark', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [paragraph] = proxy.append({
			content: [
				{
					kind: 'element',
					nodeName: 'paragraph',
					children: [
						{ kind: 'element', nodeName: 'italic', children: [{ kind: 'text', text: 'alpha beta gamma' }] },
					],
				},
			],
		})
		if (!paragraph) throw new Error('Expected paragraph node')

		const [italic] = proxy.children({ node: paragraph })
		if (!italic) throw new Error('Expected italic node')
		const [italicText] = proxy.children({ node: italic })
		if (!italicText) throw new Error('Expected italic text node')

		const wrapped = proxy.wrapTextRange({
			node: italicText,
			start: 6,
			end: 10,
			wrapper: { nodeName: 'bold' },
		})

		proxy.insertBefore({
			ref: wrapped.wrapper,
			content: [{ kind: 'text', text: '[' }],
		})
		proxy.insertAfter({
			ref: wrapped.wrapper,
			content: [{ kind: 'text', text: ']' }],
		})

		expect(proxy.toString({ node: italic })).toBe('<italic>alpha [<bold>beta</bold>] gamma</italic>')
		expect(proxy.toString()).toBe('<paragraph><italic>alpha [<bold>beta</bold>] gamma</italic></paragraph>')
	})

	test('can nest bold inside italic and then add another mark beside it', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [paragraph] = proxy.append({
			content: [
				{
					kind: 'element',
					nodeName: 'paragraph',
					children: [
						{ kind: 'element', nodeName: 'italic', children: [{ kind: 'text', text: 'alpha beta gamma' }] },
					],
				},
			],
		})
		if (!paragraph) throw new Error('Expected paragraph node')

		const [italic] = proxy.children({ node: paragraph })
		if (!italic) throw new Error('Expected italic node')
		const [italicText] = proxy.children({ node: italic })
		if (!italicText) throw new Error('Expected italic text node')

		proxy.wrapTextRange({
			node: italicText,
			start: 6,
			end: 10,
			wrapper: { nodeName: 'bold' },
		})

		const italicChildren = proxy.children({ node: italic })
		const [, boldNode, afterText] = italicChildren
		if (!boldNode || !afterText) throw new Error('Expected bold node and trailing text')

		const italicInserted = proxy.insertAfter({
			ref: boldNode,
			content: [{ kind: 'element', nodeName: 'italic', children: [{ kind: 'text', text: '!' }] }],
		})
		const extraItalic = italicInserted[0]
		if (!extraItalic) throw new Error('Expected extra italic node')

		proxy.insertText({ node: afterText, index: 0, text: ' ' })

		expect(proxy.toString({ node: extraItalic })).toBe('<italic>!</italic>')
		expect(proxy.toString({ node: italic })).toBe('<italic>alpha <bold>beta</bold><italic>!</italic>  gamma</italic>')
		expect(proxy.toString()).toBe('<paragraph><italic>alpha <bold>beta</bold><italic>!</italic>  gamma</italic></paragraph>')
	})

	test('sets and removes attributes on element refs', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [heading] = proxy.append({
			content: [
				{
					kind: 'element',
					nodeName: 'heading',
					attributes: { level: '2' },
					children: [{ kind: 'text', text: 'Title' }],
				},
			],
		})
		if (!heading) throw new Error('Expected heading node')

		proxy.setAttribute({ node: heading, name: 'level', value: '3' })
		expect(proxy.summary({ node: heading }).attributes).toEqual({ level: '3' })
		expect(proxy.toString()).toBe('<heading level="3">Title</heading>')

		proxy.removeAttribute({ node: heading, name: 'level' })
		expect(proxy.summary({ node: heading }).attributes).toEqual({})
		expect(proxy.toString()).toBe('<heading>Title</heading>')
	})

	test('adds a bullet to an existing list', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [list] = proxy.append({
			content: [
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
									children: [{ kind: 'text', text: 'Existing bullet' }],
								},
							],
						},
					],
				},
			],
		})
		if (!list) throw new Error('Expected list node')

		proxy.append({
			parent: list,
			content: [
				{
					kind: 'element',
					nodeName: 'listItem',
					children: [
						{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Added bullet' }] },
					],
				},
			],
		})

		expect(proxy.toString()).toBe(
			'<bulletlist><listitem><paragraph>Existing bullet</paragraph></listitem><listitem><paragraph>Added bullet</paragraph></listitem></bulletlist>',
		)
		expect(proxy.summary({ node: list }).nodeName).toBe('bulletList')
	})

	test('changes an existing element attribute', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [heading] = proxy.append({
			content: [
				{
					kind: 'element',
					nodeName: 'heading',
					attributes: { level: '2' },
					children: [{ kind: 'text', text: 'Details' }],
				},
			],
		})
		if (!heading) throw new Error('Expected heading node')

		proxy.setAttribute({ node: heading, name: 'level', value: '3' })

		expect(proxy.summary({ node: heading }).attributes).toEqual({ level: '3' })
		expect(proxy.toString()).toBe('<heading level="3">Details</heading>')
	})

	test('erases a section by removing its element ref', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [intro, obsolete, ending] = proxy.append({
			content: [
				{
					kind: 'element',
					nodeName: 'section',
					attributes: { id: 'intro' },
					children: [
						{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Keep intro.' }] },
					],
				},
				{
					kind: 'element',
					nodeName: 'section',
					attributes: { id: 'obsolete' },
					children: [
						{
							kind: 'element',
							nodeName: 'paragraph',
							children: [{ kind: 'text', text: 'Delete this section.' }],
						},
					],
				},
				{
					kind: 'element',
					nodeName: 'section',
					attributes: { id: 'ending' },
					children: [
						{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Keep ending.' }] },
					],
				},
			],
		})
		if (!intro || !obsolete || !ending) throw new Error('Expected section nodes')

		proxy.remove({ node: obsolete })

		expect(proxy.children()).toEqual([intro, ending])
		expect(proxy.toString()).toBe(
			'<section id="intro"><paragraph>Keep intro.</paragraph></section><section id="ending"><paragraph>Keep ending.</paragraph></section>',
		)
	})

	test('removes nodes by ref', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [first, second] = proxy.append({
			content: [
				{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Keep' }] },
				{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Remove' }] },
			],
		})
		if (!first || !second) throw new Error('Expected paragraph nodes')

		proxy.remove({ node: second })

		expect(proxy.toString()).toBe('<paragraph>Keep</paragraph>')
		expect(proxy.children()).toEqual([first])
	})

	test('rejects child insertion into text refs', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		const [paragraph] = proxy.append({
			content: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Text' }] }],
		})
		if (!paragraph) throw new Error('Expected paragraph node')
		const [text] = proxy.children({ node: paragraph })
		if (!text) throw new Error('Expected text node')

		expect(() =>
			proxy.append({
				parent: text,
				content: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Nope' }] }],
			}),
		).toThrow(YXmlInvalidNodeKindForOperationError)
	})

	test('throws for unknown node refs', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		expect(() => proxy.summary({ node: { id: 'missing', kind: 'element' } })).toThrow(UnknownYXmlNodeRefError)
	})

	test('throws for node ref kind mismatches', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)
		const [paragraph] = proxy.append({
			content: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Text' }] }],
		})
		if (!paragraph) throw new Error('Expected paragraph node')

		expect(() => proxy.summary({ node: { ...paragraph, kind: 'text' } })).toThrow(YXmlNodeRefKindMismatchError)
	})

	test('throws for child index out of bounds', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)

		expect(() => proxy.get({ index: 0 })).toThrow(YXmlChildIndexOutOfBoundsError)
	})

	test('throws when setting attributes on non-element refs', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)
		const root = proxy.root()

		expect(() => proxy.setAttribute({ node: root, name: 'id', value: 'root' })).toThrow(
			YXmlInvalidNodeKindForOperationError,
		)
	})

	test('throws for invalid text ranges', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)
		const [paragraph] = proxy.append({
			content: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Text' }] }],
		})
		if (!paragraph) throw new Error('Expected paragraph node')
		const [text] = proxy.children({ node: paragraph })
		if (!text) throw new Error('Expected text node')

		expect(() => proxy.insertText({ node: text, index: 10, text: '!' })).toThrow(YXmlTextRangeOutOfBoundsError)
		expect(() => proxy.deleteText({ node: text, index: 1, length: 10 })).toThrow(YXmlTextRangeOutOfBoundsError)
		expect(() => proxy.splitText({ node: text, index: 0 })).toThrow(YXmlTextRangeOutOfBoundsError)
		expect(() => proxy.wrapTextRange({ node: text, start: 2, end: 2, wrapper: { nodeName: 'bold' } })).toThrow(
			YXmlTextRangeOutOfBoundsError,
		)
	})

	test('throws when removing or inserting relative to the root fragment', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)
		const root = proxy.root()

		expect(() => proxy.remove({ node: root })).toThrow(YXmlRootOperationError)
		expect(() =>
			proxy.insertAfter({
				ref: root,
				content: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Nope' }] }],
			}),
		).toThrow(YXmlRootOperationError)
	})

	test('throws for operations on detached node refs', () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('artifact')
		const proxy = new YXmlProxyBindings(fragment)
		const [paragraph] = proxy.append({
			content: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Delete me' }] }],
		})
		if (!paragraph) throw new Error('Expected paragraph node')

		proxy.remove({ node: paragraph })

		expect(() =>
			proxy.insertAfter({
				ref: paragraph,
				content: [{ kind: 'element', nodeName: 'paragraph', children: [{ kind: 'text', text: 'Nope' }] }],
			}),
		).toThrow(DetachedYXmlNodeRefError)
	})
})
