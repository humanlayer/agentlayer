import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { YXmlProxyBindings } from '../src'

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
		).toThrow('Expected a fragment or element node')
	})
})
