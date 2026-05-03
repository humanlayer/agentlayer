import * as Y from 'yjs'

export type YXmlNodeKind = 'fragment' | 'element' | 'text'

export type YXmlNodeRef = {
	id: string
	kind: YXmlNodeKind
}

export type YXmlNodeSummary = YXmlNodeRef & {
	nodeName: string | null
	length: number
	xml: string
	attributes?: Record<string, string>
}

export type YXmlNodeSpec =
	| {
			kind: 'element'
			nodeName: string
			attributes?: Record<string, string>
			children?: YXmlNodeSpec[]
	  }
	| {
			kind: 'text'
			text?: string
	  }

export type YXmlProxy = {
	root(): YXmlNodeRef
	summary(input: { node: YXmlNodeRef }): YXmlNodeSummary
	children(input?: { node?: YXmlNodeRef }): YXmlNodeRef[]
	get(input: { node?: YXmlNodeRef; index: number }): YXmlNodeRef
	toString(input?: { node?: YXmlNodeRef }): string
	append(input: { parent?: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[]
	prepend(input: { parent?: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[]
	insertBefore(input: { ref: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[]
	insertAfter(input: { ref: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[]
	remove(input: { node: YXmlNodeRef }): void
	setAttribute(input: { node: YXmlNodeRef; name: string; value: string }): void
	removeAttribute(input: { node: YXmlNodeRef; name: string }): void
}

type YXmlContainer = Y.XmlFragment | Y.XmlElement
type YXmlNode = YXmlContainer | Y.XmlText
type InsertableYXmlNode = Y.XmlElement | Y.XmlText

export class YXmlProxyBindings implements YXmlProxy {
	private readonly nodes = new Map<string, YXmlNode>()
	private readonly refs = new WeakMap<object, YXmlNodeRef>()
	private nextId = 1

	constructor(private readonly rootFragment: Y.XmlFragment) {
		this.register(rootFragment)
	}

	root(): YXmlNodeRef {
		return this.register(this.rootFragment)
	}

	summary({ node }: { node: YXmlNodeRef }): YXmlNodeSummary {
		const resolved = this.resolve(node)
		const ref = this.register(resolved)
		return {
			...ref,
			nodeName: resolved instanceof Y.XmlElement ? resolved.nodeName : null,
			length: resolved.length,
			xml: resolved.toString(),
			...(resolved instanceof Y.XmlElement ? { attributes: resolved.getAttributes() } : {}),
		}
	}

	children(input: { node?: YXmlNodeRef } = {}): YXmlNodeRef[] {
		return this.resolveContainer(input.node)
			.slice()
			.map((node) => this.register(node))
	}

	get({ node, index }: { node?: YXmlNodeRef; index: number }): YXmlNodeRef {
		const child = this.resolveContainer(node).get(index)
		if (!child) throw new Error(`No YXml child at index ${index}`)
		return this.register(child)
	}

	toString(input: { node?: YXmlNodeRef } = {}): string {
		return this.resolve(input.node).toString()
	}

	append({ parent, content }: { parent?: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[] {
		const container = this.resolveContainer(parent)
		const nodesToInsert = this.buildNodes(content)
		container.push(nodesToInsert)
		return this.refsFor(nodesToInsert)
	}

	prepend({ parent, content }: { parent?: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[] {
		const container = this.resolveContainer(parent)
		const nodesToInsert = this.buildNodes(content)
		container.unshift(nodesToInsert)
		return this.refsFor(nodesToInsert)
	}

	insertBefore({ ref, content }: { ref: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[] {
		const target = this.resolve(ref)
		const parent = this.parentContainerOf(target)
		const index = parent.slice().indexOf(target as Y.XmlElement | Y.XmlText)
		if (index < 0) throw new Error('Referenced node is not a direct child of its parent')
		const nodesToInsert = this.buildNodes(content)
		parent.insert(index, nodesToInsert)
		return this.refsFor(nodesToInsert)
	}

	insertAfter({ ref, content }: { ref: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[] {
		const target = this.resolve(ref)
		const parent = this.parentContainerOf(target)
		const nodesToInsert = this.buildNodes(content)
		parent.insertAfter(target as Y.XmlElement | Y.XmlText, nodesToInsert)
		return this.refsFor(nodesToInsert)
	}

	remove({ node }: { node: YXmlNodeRef }): void {
		const target = this.resolve(node)
		const parent = this.parentContainerOf(target)
		const index = parent.slice().indexOf(target as Y.XmlElement | Y.XmlText)
		if (index < 0) throw new Error('Referenced node is not a direct child of its parent')
		parent.delete(index, 1)
	}

	setAttribute({ node, name, value }: { node: YXmlNodeRef; name: string; value: string }): void {
		this.resolveElement(node).setAttribute(name, value)
	}

	removeAttribute({ node, name }: { node: YXmlNodeRef; name: string }): void {
		this.resolveElement(node).removeAttribute(name)
	}

	private register(node: YXmlNode): YXmlNodeRef {
		const existing = this.refs.get(node)
		if (existing) return existing

		const ref = { id: `n${this.nextId++}`, kind: kindOf(node) }
		this.nodes.set(ref.id, node)
		this.refs.set(node, ref)
		return ref
	}

	private resolve(ref?: YXmlNodeRef): YXmlNode {
		if (!ref) return this.rootFragment

		const node = this.nodes.get(ref.id)
		if (!node) throw new Error(`Unknown YXml node ref: ${ref.id}`)
		if (kindOf(node) !== ref.kind) throw new Error(`YXml node ref kind mismatch for ${ref.id}`)
		return node
	}

	private resolveContainer(ref?: YXmlNodeRef): YXmlContainer {
		const node = this.resolve(ref)
		if (node instanceof Y.XmlText) throw new Error('Expected a fragment or element node')
		return node
	}

	private resolveElement(ref: YXmlNodeRef): Y.XmlElement {
		const node = this.resolve(ref)
		if (!(node instanceof Y.XmlElement)) throw new Error('Expected an element node')
		return node
	}

	private buildNodes(specs: YXmlNodeSpec[]): InsertableYXmlNode[] {
		return specs.map((spec) => this.buildNode(spec))
	}

	private buildNode(spec: YXmlNodeSpec): InsertableYXmlNode {
		if (spec.kind === 'text') {
			const text = new Y.XmlText()
			if (spec.text) text.insert(0, spec.text)
			return text
		}

		const element = new Y.XmlElement(spec.nodeName)
		for (const [name, value] of Object.entries(spec.attributes ?? {})) {
			element.setAttribute(name, value)
		}
		const children = this.buildNodes(spec.children ?? [])
		if (children.length > 0) element.insert(0, children)
		return element
	}

	private refsFor(content: InsertableYXmlNode[]): YXmlNodeRef[] {
		return content.map((node) => this.register(node))
	}

	private parentContainerOf(node: YXmlNode): YXmlContainer {
		const parent = node.parent
		if (parent instanceof Y.XmlFragment || parent instanceof Y.XmlElement) return parent
		throw new Error('Referenced node is not attached to a YXml parent')
	}
}

function kindOf(node: YXmlNode): YXmlNodeKind {
	if (node instanceof Y.XmlElement) return 'element'
	if (node instanceof Y.XmlText) return 'text'
	return 'fragment'
}
