import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { anthropic } from '@ai-sdk/anthropic'
import {
	type Agent,
	type PostToolUseHook,
	type PreToolUseHook,
	startState,
	userMessage,
} from '@humanlayer/agentlayer-core'
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror'
import * as Y from 'yjs'
import { tiptapJsonToMarkdown } from '../src'
import { createYXmlFragmentEditorAgent, userInstructionForYXmlFragmentEditorAgent } from '../src/agents'

setDefaultTimeout(200_000)

describe.skipIf(!process.env.ANTHROPIC_API_KEY || !!process.env.CI)('Live Apply Agent Tests', async () => {
	let doc: Y.Doc
	let fragment: Y.XmlFragment
	let createApplyAgent: (oldString: string, newString: string, replaceAll?: boolean) => Agent
	let toolCalls: string[]

	beforeEach(() => {
		doc = new Y.Doc()
		fragment = doc.getXmlFragment('fragment')
		toolCalls = []

		const inputLoggerHook: PreToolUseHook = (ctx) => {
			toolCalls.push(ctx.toolName)
			console.log(`Pre-tool-use hook for ${ctx.toolName} with input: ${JSON.stringify(ctx.input)}`)
			return ctx.next()
		}

		const outputLoggerHook: PostToolUseHook = (ctx) => {
			console.log(`Post-tool-use hook for ${ctx.toolName} with output ${JSON.stringify(ctx.output)}`)
			return ctx.done()
		}

		createApplyAgent = (oldString, newString, replaceAll) => {
			return createYXmlFragmentEditorAgent({
				modelConfig: anthropic('claude-sonnet-4-6'),
				fragment,
				preToolHooks: [inputLoggerHook],
				postToolHooks: [outputLoggerHook],
			})
		}
	})

	test('Simple apply should succeed', async () => {
		const heading = new Y.XmlElement('heading')
		fragment.insert(0, [heading])

		heading.setAttribute('level', '1')
		heading.push([new Y.XmlText('This is a second-level heading')])

		const oldString = '#'
		const newString = '##'
		expect(tiptapJsonToMarkdown(yXmlFragmentToProsemirrorJSON(fragment))).toContain('#')
		expect(tiptapJsonToMarkdown(yXmlFragmentToProsemirrorJSON(fragment))).not.toContain('##')
		expect(fragment.toJSON()).toEqual('<heading level="1">This is a second-level heading</heading>')

		const applyAgent = createApplyAgent(oldString, newString, true)

		const userInstruction = userInstructionForYXmlFragmentEditorAgent({ oldString, newString })
		console.log(`user instruction:`, userInstruction)

		const run = applyAgent.run({
			state: startState([userMessage(userInstruction)]),
		})

		await expect(run.result).resolves.not.toBeUndefined()
		const runResult = await run.result
		logToolCallCount('simple apply', toolCalls)

		expect(tiptapJsonToMarkdown(yXmlFragmentToProsemirrorJSON(fragment))).toContain('##')
		expect(fragment.toJSON()).toEqual('<heading level="2">This is a second-level heading</heading>')
		expect(toolCalls.length).toBeGreaterThan(0)
	})
})

describe.skipIf(!process.env.ANTHROPIC_API_KEY || !!process.env.CI)(
	'Live Apply Agent Tests - complex nested document',
	async () => {
		let doc: Y.Doc
		let fragment: Y.XmlFragment
		let createApplyAgent: (oldString: string, newString: string, replaceAll?: boolean) => Agent
		let toolCalls: string[]

		beforeEach(() => {
			doc = new Y.Doc()
			fragment = doc.getXmlFragment('fragment')
			fragment.insert(0, createComplexDocumentNodes())
			toolCalls = []

			const inputLoggerHook: PreToolUseHook = (ctx) => {
				toolCalls.push(ctx.toolName)
				console.log(`Pre-tool-use hook for ${ctx.toolName} with input: ${JSON.stringify(ctx.input)}`)
				return ctx.next()
			}

			const outputLoggerHook: PostToolUseHook = (ctx) => {
				console.log(`Post-tool-use hook for ${ctx.toolName} with output ${JSON.stringify(ctx.output)}`)
				return ctx.done()
			}

			createApplyAgent = () => {
				return createYXmlFragmentEditorAgent({
					modelConfig: anthropic('claude-sonnet-4-6'),
					fragment,
					preToolHooks: [inputLoggerHook],
					postToolHooks: [outputLoggerHook],
				})
			}
		})

		test('removes text inside inline code nested in a bulleted list item', async () => {
			expect(fragment.toJSON()).toContain('<code>this is a code block in python</code> in a bulleted list')

			await applyEdit({
				agent: createApplyAgent('in python', '', true),
				oldString: 'in python',
				newString: '',
				replaceAll: true,
			})
			logToolCallCount('removing nested inline code text', toolCalls)

			const codeContents = codeTagContents(fragment.toJSON())
			expect(codeContents).toContain('this is a code block')
			expect(codeContents).not.toContain('this is a code block in python')
			expect(codeContents.some((content) => content.includes('in python'))).toBe(false)
			expect(toolCalls.length).toBeGreaterThan(0)
		})

		test('edits text inside a nested ordered list item', async () => {
			expect(fragment.toJSON()).toContain('<listitem><paragraph>numbered </paragraph></listitem>')

			await applyEdit({
				agent: createApplyAgent('numbered', 'ordered'),
				oldString: 'numbered',
				newString: 'ordered',
			})
			logToolCallCount('editing ordered list item', toolCalls)

			expect(fragment.toJSON()).toContain('<listitem><paragraph>ordered </paragraph></listitem>')
			expect(fragment.toJSON()).not.toContain('numbered')
			expect(toolCalls.length).toBeGreaterThan(0)
		})

		test('edits text inside an inline bold mark in a paragraph', async () => {
			expect(fragment.toJSON()).toContain(
				'<paragraph>This <bold>is a bold</bold> and <italic>italic</italic> item in a paragraph</paragraph>',
			)

			await applyEdit({
				agent: createApplyAgent('is a bold', 'is bold'),
				oldString: 'is a bold',
				newString: 'is bold',
			})
			logToolCallCount('editing inline bold text', toolCalls)

			expect(fragment.toJSON()).toContain(
				'<paragraph>This <bold>is bold</bold> and <italic>italic</italic> item in a paragraph</paragraph>',
			)
			expect(fragment.toJSON()).not.toContain('<bold>is a bold</bold>')
			expect(toolCalls.length).toBeGreaterThan(0)
		})
	},
)

function logToolCallCount(label: string, toolCalls: string[]) {
	const editToolCalls = toolCalls.filter((toolName) => toolName === 'edit_yjs_xml_fragment')
	console.log(
		`Tool calls for ${label}: ${toolCalls.length} total, ${editToolCalls.length} edit calls (${toolCalls.join(', ')})`,
	)
}

function codeTagContents(xml: string) {
	return [...xml.matchAll(/<code>(.*?)<\/code>/g)].map((match) => match[1] ?? '')
}

async function applyEdit(options: { agent: Agent; oldString: string; newString: string; replaceAll?: boolean }) {
	const run = options.agent.run({
		state: startState([
			userMessage(
				userInstructionForYXmlFragmentEditorAgent({
					oldString: options.oldString,
					newString: options.newString,
					replaceAll: options.replaceAll,
				}),
			),
		]),
	})

	await expect(run.result).resolves.not.toBeUndefined()
}

function createComplexDocumentNodes(): Array<Y.XmlElement> {
	return [
		element('heading', { level: '1' }, [
			element(
				'link',
				{
					class: 'null',
					href: 'http://README.md',
					rel: 'noopener noreferrer nofollow',
					target: '_blank',
					title: 'null',
				},
				[text('README.md')],
			),
			text(' '),
		]),
		element('paragraph', {}, [text('This is an example file')]),
		element('paragraph'),
		element('paragraph'),
		list('bulletList', ['this ', 'is a ', 'bulleted list']),
		element('paragraph'),
		element('paragraph'),
		list('orderedList', ['This ', 'is ', 'a', 'numbered ', 'list'], { start: '1' }),
		element('paragraph'),
		element('codeBlock', {}, [text('this is a code block')]),
		element('paragraph'),
		element('paragraph'),
		element('paragraph'),
		element('paragraph', {}, [element('bold', {}, [text("i don't like code blocks")])]),
		element('paragraph'),
		element('codeBlock', { language: 'typescript' }, [text('this is a typescript code block')]),
		element('paragraph'),
		element('paragraph'),
		element('bulletList', {}, [
			element('listItem', {}, [
				element('paragraph', {}, [
					element('code', {}, [text('this is a code block in python')]),
					text(' in a bulleted list'),
				]),
			]),
			element('listItem', {}, [element('paragraph', {}, [text('this is a bulleted list item ')])]),
		]),
		element('paragraph'),
		element('paragraph'),
		element('paragraph', {}, [
			text('This '),
			element('bold', {}, [text('is a bold')]),
			text(' and '),
			element('italic', {}, [text('italic')]),
			text(' item in a paragraph'),
		]),
		element('paragraph'),
	]
}

function list(nodeName: 'bulletList' | 'orderedList', items: string[], attributes: Record<string, string> = {}) {
	return element(
		nodeName,
		attributes,
		items.map((item) => element('listItem', {}, [element('paragraph', {}, [text(item)])])),
	)
}

function element(
	name: string,
	attributes: Record<string, string> = {},
	children: Array<Y.XmlElement | Y.XmlText> = [],
) {
	const node = new Y.XmlElement(name)
	for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
	if (children.length > 0) node.insert(0, children)
	return node
}

function text(value: string) {
	const node = new Y.XmlText()
	node.insert(0, value)
	return node
}
