import { describe, expect, test } from 'bun:test'
import { toolsToBindings, type ToolBinding } from '@tanstack/ai-code-mode'
import { createQuickJSIsolateDriver } from '@tanstack/ai-isolate-quickjs'
import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'
import * as Y from 'yjs'

type QuickJSContext = Awaited<ReturnType<ReturnType<typeof createQuickJSIsolateDriver>['createContext']>>

async function withQuickJSContext<T>(bindings: Record<string, ToolBinding>, cb: (context: QuickJSContext) => Promise<T>) {
	const driver = createQuickJSIsolateDriver()
	let context: QuickJSContext | undefined

	try {
		context = await driver.createContext({ bindings, timeout: 5_000 })
		return await cb(context)
	} finally {
		await context?.dispose()
	}
}

describe('TanStack QuickJS isolate driver learning tests', () => {
	test('driver can execute code without host bindings', async () => {
		await withQuickJSContext({}, async (context) => {
			const result = await context.execute(`
				console.log('pure quickjs')
				return { answer: 42 }
			`)

			expect(result).toEqual({
				success: true,
				value: { answer: 42 },
				logs: ['pure quickjs'],
			})
		})
	})

	test.todo('driver can create a context with direct bindings and execute code', async () => {
		const bindings: Record<string, ToolBinding> = {
			add: {
				name: 'add',
				description: 'Add two numbers together',
				inputSchema: {
					type: 'object',
					properties: {
						a: { type: 'number' },
						b: { type: 'number' },
					},
					required: ['a', 'b'],
				},
				outputSchema: {
					type: 'object',
					properties: { sum: { type: 'number' } },
					required: ['sum'],
				},
				execute: async (args) => {
					const { a, b } = args as { a: number; b: number }
					return { sum: a + b }
				},
			},
		}

		await withQuickJSContext(bindings, async (context) => {
			const result = await context.execute(`
				const first = await add({ a: 1, b: 1 })
				const second = await add({ a: first.sum, b: 40 })
				console.log('computed', second.sum)

				return { answer: second.sum }
			`)

			expect(result).toEqual({
				success: true,
				value: { answer: 42 },
				logs: ['computed 42'],
			})
		})
	})

	test.todo('direct bindings can mutate a live Y.XmlFragment', async () => {
		const yDoc = new Y.Doc()
		const fragment = yDoc.getXmlFragment('tanstack-direct-bindings')

		const bindings: Record<string, ToolBinding> = {
			pushElement: {
				name: 'pushElement',
				description: 'Append an XML element with text to the shared Y.XmlFragment',
				inputSchema: {
					type: 'object',
					properties: {
						nodeName: { type: 'string' },
						text: { type: 'string' },
						attributes: {
							type: 'object',
							additionalProperties: { type: 'string' },
						},
					},
					required: ['nodeName', 'text'],
				},
				outputSchema: {
					type: 'object',
					properties: {
						xml: { type: 'string' },
						length: { type: 'number' },
					},
					required: ['xml', 'length'],
				},
				execute: async (args) => {
					const { nodeName, text, attributes } = args as {
						nodeName: string
						text: string
						attributes?: Record<string, string>
					}
					const element = new Y.XmlElement(nodeName)
					for (const [name, value] of Object.entries(attributes ?? {})) {
						element.setAttribute(name, value)
					}

					const xmlText = new Y.XmlText()
					xmlText.insert(0, text)
					element.push([xmlText])
					fragment.push([element])

					return { xml: fragment.toJSON(), length: fragment.length }
				},
			},
			readFragment: {
				name: 'readFragment',
				description: 'Read the shared Y.XmlFragment',
				inputSchema: { type: 'object', properties: {} },
				outputSchema: {
					type: 'object',
					properties: {
						xml: { type: 'string' },
						length: { type: 'number' },
					},
					required: ['xml', 'length'],
				},
				execute: async () => ({ xml: fragment.toJSON(), length: fragment.length }),
			},
		}

		await withQuickJSContext(bindings, async (context) => {
			const result = await context.execute(`
				await pushElement({
					nodeName: 'section',
					text: 'Hello from QuickJS',
					attributes: { id: 'intro' },
				})

				await pushElement({
					nodeName: 'paragraph',
					text: 'Bound directly through the isolate driver',
				})

				return await readFragment({})
			`)

			expect(result).toEqual({
				success: true,
				value: {
					length: 2,
					xml: '<section id="intro">Hello from QuickJS</section><paragraph>Bound directly through the isolate driver</paragraph>',
				},
				logs: [],
			})
			expect(fragment.toJSON()).toBe(
				'<section id="intro">Hello from QuickJS</section><paragraph>Bound directly through the isolate driver</paragraph>',
			)
		})
	})

	test.todo('TanStack tool definitions can be converted to direct isolate bindings', async () => {
		const add = toolDefinition({
			name: 'add',
			description: 'Add two numbers together',
			inputSchema: z.object({ a: z.number(), b: z.number() }),
			outputSchema: z.object({ sum: z.number() }),
		}).server(({ a, b }) => ({ sum: a + b }))

		await withQuickJSContext(toolsToBindings([add], 'external_'), async (context) => {
			const result = await context.execute(`
				const answer = await external_add({ a: 20, b: 22 })
				return answer
			`)

			expect(result).toEqual({
				success: true,
				value: { sum: 42 },
				logs: [],
			})
		})
	})
})
