import * as Y from 'yjs'
import { createNodeDriver, NodeExecutionDriver } from 'secure-exec'
import type { BindingTree } from 'secure-exec'

type XmlRef = {
	id: string
	kind: 'element' | 'text'
}

type XmlContentSpec =
	| {
			kind: 'element'
			nodeName: string
			attributes?: Record<string, string>
			children?: XmlContentSpec[]
		}
	| {
			kind: 'text'
			text?: string
			delta?: Array<{ insert: string; attributes?: Record<string, unknown> }>
		}

type XmlNode = Y.XmlElement | Y.XmlText

class XmlRefRegistry {
	private nextId = 1
	private readonly byId = new Map<string, XmlNode>()
	private readonly byObject = new WeakMap<object, XmlRef>()

	register(node: XmlNode): XmlRef {
		const existing = this.byObject.get(node)
		if (existing) return existing

		const ref: XmlRef = {
			id: `xml_${this.nextId++}`,
			kind: node instanceof Y.XmlText ? 'text' : 'element',
		}

		this.byId.set(ref.id, node)
		this.byObject.set(node, ref)
		return ref
	}

	resolve(ref: XmlRef): XmlNode {
		const node = this.byId.get(ref.id)
		if (!node) throw new Error(`Unknown XML ref: ${ref.id}`)
		return node
	}

	resolveElement(ref: XmlRef): Y.XmlElement {
		if (ref.kind !== 'element') throw new Error(`Expected element ref, got ${ref.kind}`)
		const node = this.resolve(ref)
		if (!(node instanceof Y.XmlElement)) throw new Error(`XML ref ${ref.id} does not resolve to Y.XmlElement`)
		return node
	}

	resolveText(ref: XmlRef): Y.XmlText {
		if (ref.kind !== 'text') throw new Error(`Expected text ref, got ${ref.kind}`)
		const node = this.resolve(ref)
		if (!(node instanceof Y.XmlText)) throw new Error(`XML ref ${ref.id} does not resolve to Y.XmlText`)
		return node
	}
}

function createXmlNode(spec: XmlContentSpec): XmlNode {
	if (spec.kind === 'text') {
		const text = new Y.XmlText()
		if (spec.delta) {
			text.applyDelta(spec.delta)
		} else if (spec.text) {
			text.insert(0, spec.text)
		}
		return text
	}

	const element = new Y.XmlElement(spec.nodeName)
	for (const [name, value] of Object.entries(spec.attributes ?? {})) {
		element.setAttribute(name, value)
	}
	if (spec.children?.length) {
		const children = spec.children.map(createXmlNode)
		element.insertAfter(null, children)
	}
	return element
}

function createXmlNodes(specs: XmlContentSpec[]): XmlNode[] {
	return specs.map(createXmlNode)
}

function maybeRef(node: XmlNode | null | undefined, registry: XmlRefRegistry): XmlRef | null | undefined {
	if (node === null) return null
	if (node === undefined) return undefined
	return registry.register(node)
}

export function createYXmlBindings(fragment: Y.XmlFragment): BindingTree {
	const registry = new XmlRefRegistry()

	return {
		fragment: {
			firstChild: () => maybeRef(fragment.firstChild, registry),
			length: () => fragment.length,
			insert: (index, content) => {
				const nodes = createXmlNodes(content as XmlContentSpec[])
				fragment.insert(index as number, nodes)
				return nodes.map((node) => registry.register(node))
			},
			insertAfter: (ref, content) => {
				const after = ref === null ? null : registry.resolve(ref as XmlRef)
				const nodes = createXmlNodes(content as XmlContentSpec[])
				fragment.insertAfter(after, nodes)
				return nodes.map((node) => registry.register(node))
			},
			delete: (index, length) => fragment.delete(index as number, length as number),
			push: (content) => {
				const nodes = createXmlNodes(content as XmlContentSpec[])
				fragment.push(nodes)
				return nodes.map((node) => registry.register(node))
			},
			unshift: (content) => {
				const nodes = createXmlNodes(content as XmlContentSpec[])
				fragment.unshift(nodes)
				return nodes.map((node) => registry.register(node))
			},
			get: (index) => maybeRef(fragment.get(index as number), registry),
			slice: (start, end) =>
				fragment.slice(start as number | undefined, end as number | undefined).map((node) => registry.register(node)),
			toJSON: () => fragment.toJSON(),
		},
		element: {
			firstChild: (ref) => maybeRef(registry.resolveElement(ref as XmlRef).firstChild, registry),
			length: (ref) => registry.resolveElement(ref as XmlRef).length,
			insert: (ref, index, content) => {
				const parent = registry.resolveElement(ref as XmlRef)
				const nodes = createXmlNodes(content as XmlContentSpec[])
				parent.insert(index as number, nodes)
				return nodes.map((node) => registry.register(node))
			},
			insertAfter: (ref, afterRef, content) => {
				const parent = registry.resolveElement(ref as XmlRef)
				const after = afterRef === null ? null : registry.resolve(afterRef as XmlRef)
				const nodes = createXmlNodes(content as XmlContentSpec[])
				parent.insertAfter(after, nodes)
				return nodes.map((node) => registry.register(node))
			},
			delete: (ref, index, length) => registry.resolveElement(ref as XmlRef).delete(index as number, length as number),
			push: (ref, content) => {
				const parent = registry.resolveElement(ref as XmlRef)
				const nodes = createXmlNodes(content as XmlContentSpec[])
				parent.push(nodes)
				return nodes.map((node) => registry.register(node))
			},
			unshift: (ref, content) => {
				const parent = registry.resolveElement(ref as XmlRef)
				const nodes = createXmlNodes(content as XmlContentSpec[])
				parent.unshift(nodes)
				return nodes.map((node) => registry.register(node))
			},
			get: (ref, index) => maybeRef(registry.resolveElement(ref as XmlRef).get(index as number), registry),
			slice: (ref, start, end) =>
				registry
					.resolveElement(ref as XmlRef)
					.slice(start as number | undefined, end as number | undefined)
					.map((node) => registry.register(node)),
			nodeName: (ref: unknown) => registry.resolveElement(ref as XmlRef).nodeName,
			prevSibling: (ref: unknown) => maybeRef(registry.resolveElement(ref as XmlRef).prevSibling, registry),
			nextSibling: (ref: unknown) => maybeRef(registry.resolveElement(ref as XmlRef).nextSibling, registry),
			toString: (ref: unknown) => registry.resolveElement(ref as XmlRef).toString(),
			getAttribute: (ref, name) => registry.resolveElement(ref as XmlRef).getAttribute(name as string),
			getAttributes: (ref) => registry.resolveElement(ref as XmlRef).getAttributes(),
			setAttribute: (ref, name, value) => registry.resolveElement(ref as XmlRef).setAttribute(name as string, value as string),
			removeAttribute: (ref, name) => registry.resolveElement(ref as XmlRef).removeAttribute(name as string),
		},
		text: {
			prevSibling: (ref: unknown) => maybeRef(registry.resolveText(ref as XmlRef).prevSibling, registry),
			nextSibling: (ref: unknown) => maybeRef(registry.resolveText(ref as XmlRef).nextSibling, registry),
			toString: (ref: unknown) => registry.resolveText(ref as XmlRef).toString(),
			toJSON: (ref: unknown) => registry.resolveText(ref as XmlRef).toJSON(),
			toDelta: (ref: unknown) => registry.resolveText(ref as XmlRef).toDelta(),
			insert: (ref, index, text, attrs) =>
				registry.resolveText(ref as XmlRef).insert(index as number, text as string, attrs as Record<string, unknown> | undefined),
			delete: (ref, index, length) => registry.resolveText(ref as XmlRef).delete(index as number, length as number),
			format: (ref, index, length, attrs) =>
				registry.resolveText(ref as XmlRef).format(index as number, length as number, attrs as Record<string, unknown>),
		},
	}
}

export async function withCodeMode(
	fragment: Y.XmlFragment,
	bindings: BindingTree,
	cb: (driver: NodeExecutionDriver) => Promise<unknown>,
) {
	const system = createNodeDriver()

	const driver = new NodeExecutionDriver({
		system,
		runtime: system.runtime,
		bindings: {
			...createYXmlBindings(fragment),
			...bindings,
		},
	})

	try {
		await cb(driver)
	} finally {
		driver.dispose()
	}
}
