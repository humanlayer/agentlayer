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

export class YXmlProxyError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message)
		this.name = 'YXmlProxyError'
	}
}

export class UnknownYXmlNodeRefError extends YXmlProxyError {
	constructor(readonly ref: YXmlNodeRef) {
		super(`Unknown YXml node ref: ${ref.id}`, 'UNKNOWN_NODE_REF')
		this.name = 'UnknownYXmlNodeRefError'
	}
}

export class YXmlNodeRefKindMismatchError extends YXmlProxyError {
	constructor(
		readonly ref: YXmlNodeRef,
		readonly actualKind: YXmlNodeKind,
	) {
		super(`YXml node ref kind mismatch for ${ref.id}: expected ${ref.kind}, got ${actualKind}`, 'NODE_REF_KIND_MISMATCH')
		this.name = 'YXmlNodeRefKindMismatchError'
	}
}

export class YXmlInvalidNodeKindForOperationError extends YXmlProxyError {
	constructor(
		readonly operation: string,
		readonly expected: string,
		readonly actual: YXmlNodeKind,
	) {
		super(`Cannot ${operation} on ${actual} node; expected ${expected}`, 'INVALID_NODE_KIND_FOR_OPERATION')
		this.name = 'YXmlInvalidNodeKindForOperationError'
	}
}

export class YXmlChildIndexOutOfBoundsError extends YXmlProxyError {
	constructor(
		readonly index: number,
		readonly length: number,
	) {
		super(`No YXml child at index ${index}; child count is ${length}`, 'CHILD_INDEX_OUT_OF_BOUNDS')
		this.name = 'YXmlChildIndexOutOfBoundsError'
	}
}

export class DetachedYXmlNodeRefError extends YXmlProxyError {
	constructor(readonly operation: string) {
		super(`Cannot ${operation} deleted YXml node`, 'DETACHED_NODE_REF')
		this.name = 'DetachedYXmlNodeRefError'
	}
}

export class YXmlRootOperationError extends YXmlProxyError {
	constructor(readonly operation: string) {
		super(`Cannot ${operation} the root YXml fragment`, 'ROOT_OPERATION')
		this.name = 'YXmlRootOperationError'
	}
}

type YXmlContainer = Y.XmlFragment | Y.XmlElement
type YXmlNode = YXmlContainer | Y.XmlText
type InsertableYXmlNode = Y.XmlElement | Y.XmlText

export class YXmlProxyBindings implements YXmlProxy {
	private readonly nodes = new Map<string, YXmlNode>()
	private readonly refs = new WeakMap<object, YXmlNodeRef>()
	private readonly deletedRefs = new Set<string>()
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
		return this.resolveContainer(input.node, 'read children from')
			.slice()
			.map((node) => this.register(node))
	}

	get({ node, index }: { node?: YXmlNodeRef; index: number }): YXmlNodeRef {
		const container = this.resolveContainer(node, 'get child from')
		const child = container.get(index)
		if (!child) throw new YXmlChildIndexOutOfBoundsError(index, container.length)
		return this.register(child)
	}

	toString(input: { node?: YXmlNodeRef } = {}): string {
		return this.resolve(input.node).toString()
	}

	append({ parent, content }: { parent?: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[] {
		const container = this.resolveContainer(parent, 'append children to')
		const nodesToInsert = this.buildNodes(content)
		container.push(nodesToInsert)
		return this.refsFor(nodesToInsert)
	}

	prepend({ parent, content }: { parent?: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[] {
		const container = this.resolveContainer(parent, 'prepend children to')
		const nodesToInsert = this.buildNodes(content)
		container.unshift(nodesToInsert)
		return this.refsFor(nodesToInsert)
	}

	insertBefore({ ref, content }: { ref: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[] {
		if (this.deletedRefs.has(ref.id)) throw new DetachedYXmlNodeRefError('insert before')
		const target = this.resolve(ref)
		if (target === this.rootFragment) throw new YXmlRootOperationError('insert before')
		const parent = this.parentContainerOf(target, 'insert before')
		const index = parent.slice().indexOf(target as Y.XmlElement | Y.XmlText)
		if (index < 0) throw new DetachedYXmlNodeRefError('insert before')
		const nodesToInsert = this.buildNodes(content)
		parent.insert(index, nodesToInsert)
		return this.refsFor(nodesToInsert)
	}

	insertAfter({ ref, content }: { ref: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[] {
		if (this.deletedRefs.has(ref.id)) throw new DetachedYXmlNodeRefError('insert after')
		const target = this.resolve(ref)
		if (target === this.rootFragment) throw new YXmlRootOperationError('insert after')
		const parent = this.parentContainerOf(target, 'insert after')
		const nodesToInsert = this.buildNodes(content)
		parent.insertAfter(target as Y.XmlElement | Y.XmlText, nodesToInsert)
		return this.refsFor(nodesToInsert)
	}

	remove({ node }: { node: YXmlNodeRef }): void {
		if (this.deletedRefs.has(node.id)) throw new DetachedYXmlNodeRefError('remove')
		const target = this.resolve(node)
		if (target === this.rootFragment) throw new YXmlRootOperationError('remove')
		const parent = this.parentContainerOf(target, 'remove')
		const index = parent.slice().indexOf(target as Y.XmlElement | Y.XmlText)
		if (index < 0) throw new DetachedYXmlNodeRefError('remove')
		parent.delete(index, 1)
		this.deletedRefs.add(node.id)
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
		if (!node) throw new UnknownYXmlNodeRefError(ref)
		const actualKind = kindOf(node)
		if (actualKind !== ref.kind) throw new YXmlNodeRefKindMismatchError(ref, actualKind)
		return node
	}

	private resolveContainer(ref: YXmlNodeRef | undefined, operation: string): YXmlContainer {
		const node = this.resolve(ref)
		if (node instanceof Y.XmlText) throw new YXmlInvalidNodeKindForOperationError(operation, 'fragment or element', 'text')
		return node
	}

	private resolveElement(ref: YXmlNodeRef): Y.XmlElement {
		const node = this.resolve(ref)
		if (!(node instanceof Y.XmlElement)) throw new YXmlInvalidNodeKindForOperationError('set or remove attribute', 'element', kindOf(node))
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

	private parentContainerOf(node: YXmlNode, operation: string): YXmlContainer {
		if (node.doc === null) throw new DetachedYXmlNodeRefError(operation)
		const parent = node.parent
		if (parent instanceof Y.XmlFragment || parent instanceof Y.XmlElement) return parent
		throw new DetachedYXmlNodeRefError(operation)
	}
}

function kindOf(node: YXmlNode): YXmlNodeKind {
	if (node instanceof Y.XmlText) return 'text'
	if ('nodeName' in node) return 'element'
	return 'fragment'
}
