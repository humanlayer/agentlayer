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

setDefaultTimeout(20_000)

describe.skipIf(!process.env.ANTHROPIC_API_KEY || !!process.env.CI)('Live Apply Agent Tests', async () => {
	let doc: Y.Doc
	let fragment: Y.XmlFragment
	let createApplyAgent: (oldString: string, newString: string, replaceAll?: boolean) => Agent

	beforeEach(() => {
		doc = new Y.Doc()
		fragment = doc.getXmlFragment('fragment')

		const inputLoggerHook: PreToolUseHook = (ctx) => {
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

		expect(tiptapJsonToMarkdown(yXmlFragmentToProsemirrorJSON(fragment))).toContain('##')
		expect(fragment.toJSON()).toEqual('<heading level="2">This is a second-level heading</heading>')
	})
})
