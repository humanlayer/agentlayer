/**
 * Anthropic provider integration tests for preToolUse hooks.
 *
 * These tests require ANTHROPIC_API_KEY and are skipped in CI.
 */

import { describe, expect, test } from 'bun:test'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import type { ApprovalHook, PreToolUseHook } from '../src'
import { Agent, defineTool, startState } from '../src'
import { getToolResults, outputValue, toolResultMessage, userMessage } from './mocks'

const TIMEOUT = 30_000

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('approval + preToolUse — anthropic provider (haiku)', () => {
	const haiku = anthropic('claude-haiku-4-5-20251001')

	const echoTool = defineTool({
		name: 'echo',
		description: 'Echoes the input text back. Use this tool when asked to echo something.',
		input: z.object({ text: z.string().describe('The text to echo') }),
		output: z.string(),
		execute: async (input) => input.text,
	})

	test(
		'ctx.deny() (approval hook) blocks tool — model sees denial message, adjusts behavior',
		async () => {
			const denyHook: ApprovalHook = (ctx) => ctx.deny('You are not allowed to use the echo tool')

			const agent = new Agent({
				model: haiku,
				system: 'When asked to echo something, use the echo tool. If the tool fails, explain what happened.',
				tools: { echo: echoTool },
				maxSteps: 5,
				hooks: { approval: [denyHook] },
			})

			const result = await agent.run({
				state: startState([userMessage('Please echo the word "hello"')]),
			}).result

			// The loop should complete (model eventually stops after seeing the denial)
			expect(['complete', 'maxSteps']).toContain(result.finishReason)

			// There should be a tool result with the denial message
			const [toolResultPart] = getToolResults(result.state.messages, { toolName: 'echo' })
			expect(toolResultPart).toBeDefined()
			expect(outputValue(toolResultPart!)).toContain('The user denied this tool call')
		},
		TIMEOUT,
	)

	test(
		'ctx.next(mutatedInput) — model receives mutated result',
		async () => {
			// Mutate the input: always uppercase the text
			const mutateHook: PreToolUseHook = (ctx) => {
				const originalText = (ctx.input as any).text as string
				return ctx.next({ ...ctx.input, text: originalText.toUpperCase() })
			}

			const agent = new Agent({
				model: haiku,
				system: 'When asked to echo, use the echo tool. Then report the result verbatim.',
				tools: { echo: echoTool },
				maxSteps: 5,
				hooks: { preToolUse: [mutateHook] },
			})

			const result = await agent.run({
				state: startState([userMessage('Please echo the word "hello"')]),
			}).result

			expect(['complete', 'maxSteps']).toContain(result.finishReason)

			// The tool result should have the uppercased text
			const [toolResultPart] = getToolResults(result.state.messages, { toolName: 'echo' })
			expect(toolResultPart).toBeDefined()
			// The model should have received "HELLO" (uppercased)
			expect(outputValue(toolResultPart!)).toBe('HELLO')
		},
		TIMEOUT,
	)

	test(
		'ctx.ask() (approval hook) — loop stops with approvalRequired, resume with synthetic result → loop continues',
		async () => {
			const doneTool = defineTool({
				name: 'done',
				description: 'Call this when you have finished the task.',
				input: z.object({ summary: z.string() }),
				execute: async (input) => `Task complete: ${input.summary}`,
			})

			// Ask for approval on echo (in approval hook)
			const askHook: ApprovalHook = (ctx) => {
				if (ctx.toolName === 'echo') {
					return ctx.ask({ message: 'Approve echo operation?' })
				}
				return ctx.next()
			}

			const agent = new Agent({
				model: haiku,
				system: 'When asked to echo, use the echo tool. Then call done with a summary.',
				tools: { echo: echoTool, done: doneTool },
				maxSteps: 5,
				hooks: { approval: [askHook] },
			})

			// First run: stops at echo (approvalRequired)
			const run1 = await agent.run({
				state: startState([userMessage('Please echo the word "hello"')]),
			}).result

			expect(run1.finishReason).toBe('approvalRequired')
			expect(run1.state.pendingToolCalls).toBeDefined()
			expect(run1.state.pendingToolCalls!.length).toBeGreaterThan(0)

			const pendingEcho = run1.state.pendingToolCalls!.find((p) => p.toolName === 'echo')
			expect(pendingEcho).toBeDefined()
			expect(pendingEcho!.type).toBe('approval')

			// Resume with a synthetic tool result for the echo tool
			const pendingToolCallId = pendingEcho!.toolCallId
			const syntheticResult = toolResultMessage(pendingToolCallId, 'echo', 'hello (approved)')

			// On resume, we need a new agent that doesn't ask for approval
			// (or passes the approval through)
			const agentNoHook = new Agent({
				model: haiku,
				system: 'When asked to echo, use the echo tool. Then call done with a summary.',
				tools: { echo: echoTool, done: doneTool },
				maxSteps: 5,
			})

			const run2 = await agentNoHook.run({
				state: startState([...run1.state.messages, syntheticResult]),
			}).result

			// Model should continue with the synthetic result
			expect(['complete', 'maxSteps']).toContain(run2.finishReason)
			// run2 should have new messages
			expect(run2.newMessages.length).toBeGreaterThan(0)
		},
		TIMEOUT,
	)
})
