import { beforeEach, describe, expect, test } from 'bun:test'
import { withQuickJsMode } from '@humanlayer/quickjs-exec'
import * as Y from 'yjs'
import { YXmlProxyBindings } from '../src'

describe('Y.XMLFragment Proxy tests', () => {
	describe('Operations through proxy should propagate to document', () => {
		let doc: Y.Doc
		let fragment: Y.XmlFragment
		let proxy: YXmlProxyBindings
		let root: Y.XmlElement

		beforeEach(() => {
			doc = new Y.Doc()
			fragment = doc.getXmlFragment('artifact')
			proxy = new YXmlProxyBindings(fragment)
			root = new Y.XmlElement('root')
		})

		test('Adding fragment should succeed', () => {
			fragment.insert(0, [root])
			expect(fragment.toJSON()).toEqual('<root></root>')
		})

		test('Adding another fragment NOT through proxy should succeed', () => {
			fragment.insert(0, [root])
			expect(fragment.toJSON()).toEqual('<root></root>')

			const parent = new Y.XmlElement('parent')
			const child = new Y.XmlElement('child')

			parent.insert(0, [child])
			root.insert(0, [parent])

			expect(fragment.toJSON()).toEqual('<root><parent><child></child></parent></root>')
		})

		test('Adding another fragment through proxy should succeed', () => {
			fragment.insert(0, [root])
			expect(fragment.toJSON()).toEqual('<root></root>')

			const fragmentRef = proxy.root()
			const rootRef = proxy.get({ node: fragmentRef, index: 0 })
			expect(proxy.toString({ node: rootRef })).toEqual('<root></root>')

			const insertedParent = proxy.append({
				parent: rootRef,
				content: [{ kind: 'element', nodeName: 'parent' }],
			})
			expect(insertedParent).toHaveLength(1)
			const parentRef = insertedParent[0]
			if (!parentRef) throw new Error('Expected parent ref')

			expect(proxy.toString({ node: parentRef })).toEqual('<parent></parent>')
			expect(fragment.toJSON()).toEqual('<root><parent></parent></root>')

			const insertedChild = proxy.append({
				parent: parentRef,
				content: [{ kind: 'element', nodeName: 'child' }],
			})
			expect(insertedChild).toHaveLength(1)
			const childRef = insertedChild[0]
			if (!childRef) throw new Error('Expected child ref')

			expect(proxy.toString({ node: childRef })).toEqual('<child></child>')
			expect(proxy.toString({ node: parentRef })).toEqual('<parent><child></child></parent>')
			expect(fragment.toJSON()).toEqual('<root><parent><child></child></parent></root>')
		})

		test('Adding another fragment through quickjs through proxy should succeed', async () => {
			fragment.insert(0, [root])
			expect(fragment.toJSON()).toEqual('<root></root>')

			await withQuickJsMode(proxy.bindings, (qjs) => {
				qjs.run<{ root: string }>(`
					({
						root: bindings.toString({node: bindings.get({node: bindings.root(), index: 0})})
					})
				`)
			})

			await withQuickJsMode(proxy.bindings, (qjs) => {
				qjs.run<unknown>(`
					const fragmentRef = bindings.root()
					const rootRef = bindings.get({ node: fragmentRef, index: 0 })
					bindings.append({
						parent: rootRef,
						content: [{ kind: 'element', nodeName: 'parent' }],
					})
				`)
			})
			expect(fragment.toJSON()).toEqual('<root><parent></parent></root>')

			await withQuickJsMode(proxy.bindings, (qjs) => {
				qjs.run<unknown>(`
					const fragmentRef = bindings.root()
					const rootRef = bindings.get({ node: fragmentRef, index: 0 })
					const parentRef = bindings.get({ node: rootRef, index: 0 })
					bindings.append({
						parent: parentRef,
						content: [{ kind: 'element', nodeName: 'child' }],
					})	
				`)
			})

			expect(fragment.toJSON()).toEqual('<root><parent><child></child></parent></root>')
		})
	})

	describe('Complex operations can be expressed through proxy', async () => {
		let doc: Y.Doc
		let fragment: Y.XmlFragment
		let proxy: YXmlProxyBindings
		let _root: Y.XmlElement
		beforeEach(() => {
			doc = new Y.Doc()
			fragment = doc.getXmlFragment('artifact')
			proxy = new YXmlProxyBindings(fragment)
			_root = new Y.XmlElement('root')
		})

		test('can edit a deeply nested fragment at multiple tree levels', () => {
			fragment.insert(0, [createDeepTreeRoot()])

			expect(fragment.toJSON()).toEqual(
				'<root><section id="alpha"><heading level="2">Alpha</heading><paragraph>Intro</paragraph><bulletlist><listitem><paragraph>First bullet</paragraph></listitem><listitem><paragraph>Second bullet</paragraph></listitem></bulletlist></section><section id="beta"><paragraph>Beta intro</paragraph><blockquote><paragraph>Nested quote</paragraph></blockquote></section></root>',
			)

			const fragmentRef = proxy.root()
			const rootRef = proxy.get({ node: fragmentRef, index: 0 })
			const alphaSection = proxy.get({ node: rootRef, index: 0 })
			const betaSection = proxy.get({ node: rootRef, index: 1 })
			const alphaList = proxy.get({ node: alphaSection, index: 2 })
			const secondListItem = proxy.get({ node: alphaList, index: 1 })
			const secondListParagraph = proxy.get({ node: secondListItem, index: 0 })
			const betaQuote = proxy.get({ node: betaSection, index: 1 })

			proxy.insertBefore({
				ref: alphaSection,
				content: [
					{
						kind: 'element',
						nodeName: 'heading',
						attributes: { level: '1' },
						children: [{ kind: 'text', text: 'Document Title' }],
					},
				],
			})
			expect(fragment.toJSON()).toEqual(
				'<root><heading level="1">Document Title</heading><section id="alpha"><heading level="2">Alpha</heading><paragraph>Intro</paragraph><bulletlist><listitem><paragraph>First bullet</paragraph></listitem><listitem><paragraph>Second bullet</paragraph></listitem></bulletlist></section><section id="beta"><paragraph>Beta intro</paragraph><blockquote><paragraph>Nested quote</paragraph></blockquote></section></root>',
			)

			proxy.insertAfter({
				ref: secondListParagraph,
				content: [
					{
						kind: 'element',
						nodeName: 'paragraph',
						children: [{ kind: 'text', text: 'Inserted after second bullet paragraph' }],
					},
				],
			})
			expect(proxy.toString({ node: secondListItem })).toEqual(
				'<listitem><paragraph>Second bullet</paragraph><paragraph>Inserted after second bullet paragraph</paragraph></listitem>',
			)

			proxy.append({
				parent: betaQuote,
				content: [
					{
						kind: 'element',
						nodeName: 'paragraph',
						children: [{ kind: 'text', text: 'Quote follow-up' }],
					},
				],
			})
			expect(proxy.toString({ node: betaQuote })).toEqual(
				'<blockquote><paragraph>Nested quote</paragraph><paragraph>Quote follow-up</paragraph></blockquote>',
			)

			proxy.prepend({
				parent: betaSection,
				content: [
					{
						kind: 'element',
						nodeName: 'heading',
						attributes: { level: '3' },
						children: [{ kind: 'text', text: 'Beta heading' }],
					},
				],
			})
			expect(proxy.toString({ node: betaSection })).toEqual(
				'<section id="beta"><heading level="3">Beta heading</heading><paragraph>Beta intro</paragraph><blockquote><paragraph>Nested quote</paragraph><paragraph>Quote follow-up</paragraph></blockquote></section>',
			)

			expect(fragment.toJSON()).toEqual(
				'<root><heading level="1">Document Title</heading><section id="alpha"><heading level="2">Alpha</heading><paragraph>Intro</paragraph><bulletlist><listitem><paragraph>First bullet</paragraph></listitem><listitem><paragraph>Second bullet</paragraph><paragraph>Inserted after second bullet paragraph</paragraph></listitem></bulletlist></section><section id="beta"><heading level="3">Beta heading</heading><paragraph>Beta intro</paragraph><blockquote><paragraph>Nested quote</paragraph><paragraph>Quote follow-up</paragraph></blockquote></section></root>',
			)
		})
	})
})

function createDeepTreeRoot(): Y.XmlElement {
	const root = new Y.XmlElement('root')

	const alphaSection = new Y.XmlElement('section')
	alphaSection.setAttribute('id', 'alpha')
	alphaSection.insert(0, [
		createElement('heading', { level: '2' }, [createText('Alpha')]),
		createElement('paragraph', {}, [createText('Intro')]),
		createElement('bulletList', {}, [
			createElement('listItem', {}, [createElement('paragraph', {}, [createText('First bullet')])]),
			createElement('listItem', {}, [createElement('paragraph', {}, [createText('Second bullet')])]),
		]),
	])

	const betaSection = new Y.XmlElement('section')
	betaSection.setAttribute('id', 'beta')
	betaSection.insert(0, [
		createElement('paragraph', {}, [createText('Beta intro')]),
		createElement('blockquote', {}, [createElement('paragraph', {}, [createText('Nested quote')])]),
	])

	root.insert(0, [alphaSection, betaSection])
	return root
}

function createElement(
	name: string,
	attributes: Record<string, string>,
	children: Array<Y.XmlElement | Y.XmlText>,
): Y.XmlElement {
	const element = new Y.XmlElement(name)
	for (const [key, value] of Object.entries(attributes)) {
		element.setAttribute(key, value)
	}
	if (children.length > 0) element.insert(0, children)
	return element
}

function createText(value: string): Y.XmlText {
	const text = new Y.XmlText()
	text.insert(0, value)
	return text
}
