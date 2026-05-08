import type { QuickJsBindings } from '@humanlayer/quickjs-exec'
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

export type YXmlElementWrapperSpec = {
	nodeName: string
	attributes?: Record<string, string>
}

export type YXmlProxy = {
	root(): YXmlNodeRef
	summary(input: { node: YXmlNodeRef }): YXmlNodeSummary
	children(input?: { node?: YXmlNodeRef }): YXmlNodeRef[]
	get(input: { node?: YXmlNodeRef; index: number }): YXmlNodeRef
	text(input: { node: YXmlNodeRef }): string
	toString(input?: { node?: YXmlNodeRef }): string
	append(input: { parent?: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[]
	prepend(input: { parent?: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[]
	insertBefore(input: { ref: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[]
	insertAfter(input: { ref: YXmlNodeRef; content: YXmlNodeSpec[] }): YXmlNodeRef[]
	insertText(input: { node: YXmlNodeRef; index: number; text: string }): void
	deleteText(input: { node: YXmlNodeRef; index: number; length: number }): void
	splitText(input: { node: YXmlNodeRef; index: number }): { left: YXmlNodeRef; right: YXmlNodeRef }
	wrapTextRange(input: { node: YXmlNodeRef; start: number; end: number; wrapper: YXmlElementWrapperSpec }): {
		wrapper: YXmlNodeRef
		child: YXmlNodeRef
		before?: YXmlNodeRef
		after?: YXmlNodeRef
	}
	wrap(input: { node: YXmlNodeRef; wrapper: YXmlElementWrapperSpec }): { wrapper: YXmlNodeRef; child: YXmlNodeRef }
	remove(input: { node: YXmlNodeRef }): void
	setAttribute(input: { node: YXmlNodeRef; name: string; value: string }): void
	removeAttribute(input: { node: YXmlNodeRef; name: string }): void
}

export type YXmlProxyHostBindings = YXmlProxy & QuickJsBindings

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
		super(
			`YXml node ref kind mismatch for ${ref.id}: expected ${ref.kind}, got ${actualKind}`,
			'NODE_REF_KIND_MISMATCH',
		)
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

export class YXmlTextRangeOutOfBoundsError extends YXmlProxyError {
	constructor(
		readonly operation: string,
		readonly start: number,
		readonly end: number,
		readonly length: number,
	) {
		super(`Cannot ${operation} text range [${start}, ${end}) on text length ${length}`, 'TEXT_RANGE_OUT_OF_BOUNDS')
		this.name = 'YXmlTextRangeOutOfBoundsError'
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
	readonly bindings: YXmlProxyHostBindings

	constructor(private readonly rootFragment: Y.XmlFragment) {
		this.register(rootFragment)
		this.bindings = {
			root: () => this.root(),
			summary: (input) => this.summary(input as { node: YXmlNodeRef }),
			children: (input) => this.children(input as { node?: YXmlNodeRef } | undefined),
			get: (input) => this.get(input as { node?: YXmlNodeRef; index: number }),
			text: (input) => this.text(input as { node: YXmlNodeRef }),
			toString: (input) => this.toString(input as { node?: YXmlNodeRef } | undefined),
			append: (input) => this.append(input as { parent?: YXmlNodeRef; content: YXmlNodeSpec[] }),
			prepend: (input) => this.prepend(input as { parent?: YXmlNodeRef; content: YXmlNodeSpec[] }),
			insertBefore: (input) => this.insertBefore(input as { ref: YXmlNodeRef; content: YXmlNodeSpec[] }),
			insertAfter: (input) => this.insertAfter(input as { ref: YXmlNodeRef; content: YXmlNodeSpec[] }),
			insertText: (input) => this.insertText(input as { node: YXmlNodeRef; index: number; text: string }),
			deleteText: (input) => this.deleteText(input as { node: YXmlNodeRef; index: number; length: number }),
			splitText: (input) => this.splitText(input as { node: YXmlNodeRef; index: number }),
			wrapTextRange: (input) =>
				this.wrapTextRange(
					input as {
						node: YXmlNodeRef
						start: number
						end: number
						wrapper: YXmlElementWrapperSpec
					},
				),
			wrap: (input) => this.wrap(input as { node: YXmlNodeRef; wrapper: YXmlElementWrapperSpec }),
			remove: (input) => this.remove(input as { node: YXmlNodeRef }),
			setAttribute: (input) => this.setAttribute(input as { node: YXmlNodeRef; name: string; value: string }),
			removeAttribute: (input) => this.removeAttribute(input as { node: YXmlNodeRef; name: string }),
		} as YXmlProxyHostBindings
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

	text({ node }: { node: YXmlNodeRef }): string {
		return this.resolveText(node).toString()
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

	insertText({ node, index, text }: { node: YXmlNodeRef; index: number; text: string }): void {
		if (this.deletedRefs.has(node.id)) throw new DetachedYXmlNodeRefError('insert text')
		const target = this.resolveText(node)
		this.assertTextRange({ operation: 'insert text into', length: target.length, start: index, end: index })
		if (text.length === 0) return
		target.insert(index, text)
	}

	deleteText({ node, index, length }: { node: YXmlNodeRef; index: number; length: number }): void {
		if (this.deletedRefs.has(node.id)) throw new DetachedYXmlNodeRefError('delete text')
		const target = this.resolveText(node)
		this.assertTextRange({
			operation: 'delete text from',
			length: target.length,
			start: index,
			end: index + length,
		})
		if (length === 0) return
		target.delete(index, length)
	}

	splitText({ node, index }: { node: YXmlNodeRef; index: number }): { left: YXmlNodeRef; right: YXmlNodeRef } {
		if (this.deletedRefs.has(node.id)) throw new DetachedYXmlNodeRefError('split text')
		const target = this.resolveText(node)
		this.assertTextRange({ operation: 'split text', length: target.length, start: index, end: index })
		if (index === 0 || index === target.length) {
			throw new YXmlTextRangeOutOfBoundsError('split text', index, index, target.length)
		}

		const value = target.toString()
		const left = this.buildTextNode(value.slice(0, index))
		const right = this.buildTextNode(value.slice(index))
		this.replaceNode(target, 'split text', [left, right], node.id)

		return { left: this.register(left), right: this.register(right) }
	}

	wrapTextRange({
		node,
		start,
		end,
		wrapper,
	}: {
		node: YXmlNodeRef
		start: number
		end: number
		wrapper: YXmlElementWrapperSpec
	}): { wrapper: YXmlNodeRef; child: YXmlNodeRef; before?: YXmlNodeRef; after?: YXmlNodeRef } {
		if (this.deletedRefs.has(node.id)) throw new DetachedYXmlNodeRefError('wrap text range')
		const target = this.resolveText(node)
		this.assertTextRange({ operation: 'wrap text range in', length: target.length, start, end })
		if (start === end) throw new YXmlTextRangeOutOfBoundsError('wrap text range', start, end, target.length)

		const value = target.toString()
		const beforeText = value.slice(0, start)
		const wrappedText = value.slice(start, end)
		const afterText = value.slice(end)

		const nodesToInsert: InsertableYXmlNode[] = []
		let beforeNode: Y.XmlText | undefined
		if (beforeText.length > 0) {
			beforeNode = this.buildTextNode(beforeText)
			nodesToInsert.push(beforeNode)
		}

		const child = this.buildTextNode(wrappedText)
		const wrapperNode = new Y.XmlElement(wrapper.nodeName)
		for (const [name, value] of Object.entries(wrapper.attributes ?? {})) {
			wrapperNode.setAttribute(name, value)
		}
		wrapperNode.insert(0, [child])
		nodesToInsert.push(wrapperNode)

		let afterNode: Y.XmlText | undefined
		if (afterText.length > 0) {
			afterNode = this.buildTextNode(afterText)
			nodesToInsert.push(afterNode)
		}

		this.replaceNode(target, 'wrap text range', nodesToInsert, node.id)

		return {
			...(beforeNode ? { before: this.register(beforeNode) } : {}),
			wrapper: this.register(wrapperNode),
			child: this.register(child),
			...(afterNode ? { after: this.register(afterNode) } : {}),
		}
	}

	wrap({ node, wrapper }: { node: YXmlNodeRef; wrapper: YXmlElementWrapperSpec }): {
		wrapper: YXmlNodeRef
		child: YXmlNodeRef
	} {
		if (this.deletedRefs.has(node.id)) throw new DetachedYXmlNodeRefError('wrap')
		const target = this.resolve(node)
		if (target === this.rootFragment) throw new YXmlRootOperationError('wrap')
		const parent = this.parentContainerOf(target, 'wrap')
		const index = parent.slice().indexOf(target as Y.XmlElement | Y.XmlText)
		if (index < 0) throw new DetachedYXmlNodeRefError('wrap')

		const child = this.cloneNode(target as InsertableYXmlNode)
		const wrapperNode = new Y.XmlElement(wrapper.nodeName)
		for (const [name, value] of Object.entries(wrapper.attributes ?? {})) {
			wrapperNode.setAttribute(name, value)
		}
		wrapperNode.insert(0, [child])

		parent.delete(index, 1)
		parent.insert(index, [wrapperNode])
		this.deletedRefs.add(node.id)

		return { wrapper: this.register(wrapperNode), child: this.register(child) }
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
		if (node instanceof Y.XmlText)
			throw new YXmlInvalidNodeKindForOperationError(operation, 'fragment or element', 'text')
		return node
	}

	private resolveElement(ref: YXmlNodeRef): Y.XmlElement {
		const node = this.resolve(ref)
		if (!(node instanceof Y.XmlElement))
			throw new YXmlInvalidNodeKindForOperationError('set or remove attribute', 'element', kindOf(node))
		return node
	}

	private resolveText(ref: YXmlNodeRef): Y.XmlText {
		const node = this.resolve(ref)
		if (!(node instanceof Y.XmlText))
			throw new YXmlInvalidNodeKindForOperationError('read or edit text', 'text', kindOf(node))
		return node
	}

	private buildNodes(specs: YXmlNodeSpec[]): InsertableYXmlNode[] {
		return specs.map((spec) => this.buildNode(spec))
	}

	private buildNode(spec: YXmlNodeSpec): InsertableYXmlNode {
		if (spec.kind === 'text') {
			return this.buildTextNode(spec.text ?? '')
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

	private buildTextNode(value: string): Y.XmlText {
		const text = new Y.XmlText()
		if (value.length > 0) text.insert(0, value)
		return text
	}

	private cloneNode(node: InsertableYXmlNode): InsertableYXmlNode {
		if (node instanceof Y.XmlText) {
			return this.buildTextNode(node.toString())
		}

		const element = new Y.XmlElement(node.nodeName)
		for (const [name, value] of Object.entries(node.getAttributes())) {
			element.setAttribute(name, value ?? '')
		}
		const children = node.slice().map((child) => this.cloneNode(child as InsertableYXmlNode))
		if (children.length > 0) element.insert(0, children)
		return element
	}

	private replaceNode(
		node: InsertableYXmlNode,
		operation: string,
		replacements: InsertableYXmlNode[],
		deletedRefId: string,
	): void {
		const parent = this.parentContainerOf(node, operation)
		const index = parent.slice().indexOf(node)
		if (index < 0) throw new DetachedYXmlNodeRefError(operation)
		parent.delete(index, 1)
		if (replacements.length > 0) parent.insert(index, replacements)
		this.deletedRefs.add(deletedRefId)
	}

	private assertTextRange({
		operation,
		length,
		start,
		end,
	}: {
		operation: string
		length: number
		start: number
		end: number
	}): void {
		if (start < 0 || end < start || end > length) {
			throw new YXmlTextRangeOutOfBoundsError(operation, start, end, length)
		}
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
