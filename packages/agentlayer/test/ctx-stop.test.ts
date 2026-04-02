/**
 * Tests for ctx.stop() — Phase 1 of the hooks/middleware system.
 *
 * Validates that:
 * - Tools can call ctx.stop() to halt the agent loop
 * - include: true → tool result IS appended, loop stops
 * - include: false → tool result NOT appended, appears in pendingToolCalls
 * - dropParallel: false → sibling results appended when one tool stops
 * - dropParallel: true → no results appended, all tools in pendingToolCalls
 * - return ctx.stop(...) pattern works naturally
 */

import { describe, expect, test } from 'bun:test'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { Agent, defineTool, maxSteps, startState, toolCompleted } from '../src'
import {
	assistantText,
	assistantWithToolCall,
	assistantWithToolCalls,
	extractToolCallId,
	getToolResults,
	mockModel,
	outputValue,
	toolResultMessage,
	userMessage,
} from './mocks'

// ─── ctx.stop() with include: true (default) ──────────────────────────────────

describe('ctx.stop() — include: true (default)', () => {
	test('tool result IS appended to messages, loop stops with finishReason: stopCondition', async () => {
		const stoppingTool = defineTool({
			name: 'stopper',
			description: 'Stops the agent',
			input: z.object({}),
			output: z.string(),
			execute: async (_input, ctx) => {
				return ctx.stop({ include: true, reason: 'tool requested stop' })
			},
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('stopper', {}),
				// Should not be reached
				assistantText('Should not reach here'),
			]),
			tools: { stopper: stoppingTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition?.name).toBe('ctx.stop')
		expect(result.stopCondition?.message).toBe('tool requested stop')

		// The tool result SHOULD be in messages (include: true)
		expect(getToolResults(result.state.messages, { toolName: 'stopper' })).toHaveLength(1)
	})

	test('default include (no option) also appends the tool result', async () => {
		const stoppingTool = defineTool({
			name: 'stopper',
			description: 'Stops the agent',
			input: z.object({}),
			output: z.string(),
			execute: async (_input, ctx) => {
				// No options — defaults to include: true
				return ctx.stop()
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('stopper', {})]),
			tools: { stopper: stoppingTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.finishReason).toBe('stopCondition')

		// Tool result IS in messages (include defaults to true)
		expect(getToolResults(result.state.messages, { toolName: 'stopper' })).toHaveLength(1)
	})
})

// ─── ctx.stop() with include: false ──────────────────────────────────────────

describe('ctx.stop() — include: false', () => {
	test('tool result NOT appended, appears in pendingToolCalls', async () => {
		const stoppingTool = defineTool({
			name: 'stopper',
			description: 'Stops the agent',
			input: z.object({}),
			output: z.string(),
			execute: async (_input, ctx) => {
				return ctx.stop({ include: false, reason: 'do not append' })
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('stopper', {})]),
			tools: { stopper: stoppingTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')

		// Tool result should NOT be in messages
		expect(getToolResults(result.state.messages, { toolName: 'stopper' })).toHaveLength(0)

		// Should appear in pendingToolCalls
		expect(result.state.pendingToolCalls).toBeDefined()
		expect(result.state.pendingToolCalls!.length).toBeGreaterThan(0)
		const pending = result.state.pendingToolCalls!.find((p) => p.toolName === 'stopper')
		expect(pending).toBeDefined()
		expect(pending!.type).toBe('stopped')
	})

	test('pendingToolCalls entry has reason from stop options', async () => {
		const stoppingTool = defineTool({
			name: 'stopper',
			description: 'Stops the agent',
			input: z.object({}),
			output: z.string(),
			execute: async (_input, ctx) => {
				return ctx.stop({ include: false, reason: 'approval required' })
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('stopper', {})]),
			tools: { stopper: stoppingTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.state.pendingToolCalls).toBeDefined()
		const pending = result.state.pendingToolCalls!.find((p) => p.toolName === 'stopper')
		expect(pending).toBeDefined()
		expect((pending as any).reason).toBe('approval required')
	})
})

// ─── Parallel tools: one stops with dropParallel: false ──────────────────────

describe('ctx.stop() — parallel tools, dropParallel: false', () => {
	test('sibling results ARE appended, stopped tool uses include flag', async () => {
		let normalExecuted = false

		const stoppingTool = defineTool({
			name: 'stopper',
			description: 'Stops',
			input: z.object({}),
			output: z.string(),
			execute: async (_input, ctx) => {
				return ctx.stop({ include: true, dropParallel: false, reason: 'stop' })
			},
		})

		const normalTool = defineTool({
			name: 'normal',
			description: 'Normal tool',
			input: z.object({}),
			output: z.string(),
			execute: async () => {
				normalExecuted = true
				return 'normal result'
			},
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls({ toolName: 'stopper', input: {} }, { toolName: 'normal', input: {} }),
			]),
			tools: { stopper: stoppingTool, normal: normalTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(normalExecuted).toBe(true)

		// Normal tool result SHOULD be in messages (dropParallel: false)
		expect(getToolResults(result.state.messages, { toolName: 'normal' })).toHaveLength(1)

		// Stopped tool result SHOULD also be in messages (include: true)
		expect(getToolResults(result.state.messages, { toolName: 'stopper' })).toHaveLength(1)

		// No pending tool calls (all were included)
		const hasPending = result.state.pendingToolCalls && result.state.pendingToolCalls.length > 0
		expect(hasPending).toBeFalsy()
	})

	test('stopped tool with include: false excluded, siblings included when dropParallel: false', async () => {
		const stoppingTool = defineTool({
			name: 'stopper',
			description: 'Stops',
			input: z.object({}),
			output: z.string(),
			execute: async (_input, ctx) => {
				return ctx.stop({ include: false, dropParallel: false })
			},
		})

		const normalTool = defineTool({
			name: 'normal',
			description: 'Normal tool',
			input: z.object({}),
			output: z.string(),
			execute: async () => 'normal result',
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls({ toolName: 'stopper', input: {} }, { toolName: 'normal', input: {} }),
			]),
			tools: { stopper: stoppingTool, normal: normalTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')

		// Normal tool result IS in messages (dropParallel: false)
		expect(getToolResults(result.state.messages, { toolName: 'normal' })).toHaveLength(1)

		// Stopper NOT in messages (include: false)
		expect(getToolResults(result.state.messages, { toolName: 'stopper' })).toHaveLength(0)

		// Stopper in pendingToolCalls
		expect(result.state.pendingToolCalls).toBeDefined()
		const pending = result.state.pendingToolCalls!.find((p) => p.toolName === 'stopper')
		expect(pending).toBeDefined()
		expect(pending!.type).toBe('stopped')
	})
})

// ─── Parallel tools: one stops with dropParallel: true ───────────────────────

describe('ctx.stop() — parallel tools, dropParallel: true', () => {
	test('no results appended, all tools appear in pendingToolCalls', async () => {
		const stoppingTool = defineTool({
			name: 'stopper',
			description: 'Stops',
			input: z.object({}),
			output: z.string(),
			execute: async (_input, ctx) => {
				return ctx.stop({ include: false, dropParallel: true })
			},
		})

		const normalTool = defineTool({
			name: 'normal',
			description: 'Normal tool',
			input: z.object({}),
			output: z.string(),
			execute: async () => 'normal result',
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls({ toolName: 'stopper', input: {} }, { toolName: 'normal', input: {} }),
			]),
			tools: { stopper: stoppingTool, normal: normalTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')

		// NO tool results in messages
		expect(getToolResults(result.state.messages)).toHaveLength(0)

		// Both tools in pendingToolCalls
		expect(result.state.pendingToolCalls).toBeDefined()
		expect(result.state.pendingToolCalls!.length).toBe(2)

		const stopperPending = result.state.pendingToolCalls!.find((p) => p.toolName === 'stopper')
		expect(stopperPending).toBeDefined()
		expect(stopperPending!.type).toBe('stopped')

		const normalPending = result.state.pendingToolCalls!.find((p) => p.toolName === 'normal')
		expect(normalPending).toBeDefined()
		expect(normalPending!.type).toBe('stopped')
	})

	test('stopped tool with include: true + dropParallel: true — only stopped appended, sibling excluded', async () => {
		const stoppingTool = defineTool({
			name: 'stopper',
			description: 'Stops',
			input: z.object({}),
			output: z.string(),
			execute: async (_input, ctx) => {
				// include: true means the stopper's result IS appended
				// but dropParallel: true drops ALL siblings
				return ctx.stop({ include: true, dropParallel: true, output: 'stop output' })
			},
		})

		const normalTool = defineTool({
			name: 'normal',
			description: 'Normal tool',
			input: z.object({}),
			output: z.string(),
			execute: async () => 'normal result',
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls({ toolName: 'stopper', input: {} }, { toolName: 'normal', input: {} }),
			]),
			tools: { stopper: stoppingTool, normal: normalTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')

		// Stopper IS in messages (include: true)
		expect(getToolResults(result.state.messages, { toolName: 'stopper' })).toHaveLength(1)

		// Normal is NOT in messages (dropParallel: true)
		expect(getToolResults(result.state.messages, { toolName: 'normal' })).toHaveLength(0)

		// Normal appears in pendingToolCalls
		expect(result.state.pendingToolCalls).toBeDefined()
		const normalPending = result.state.pendingToolCalls!.find((p) => p.toolName === 'normal')
		expect(normalPending).toBeDefined()
	})
})

// ─── return ctx.stop(...) pattern ─────────────────────────────────────────────

describe('ctx.stop() — return pattern', () => {
	test('tool naturally halts by returning ctx.stop()', async () => {
		let afterStopExecuted = false

		const stoppingTool = defineTool({
			name: 'conditional',
			description: 'Conditionally stops',
			input: z.object({ shouldStop: z.boolean() }),
			output: z.string(),
			execute: async (input, ctx) => {
				if (input.shouldStop) {
					return ctx.stop({ reason: 'condition met' })
					// biome-ignore lint: unreachable code for test purposes
					afterStopExecuted = true // This should never execute
					return 'unreachable'
				}
				return 'normal'
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('conditional', { shouldStop: true })]),
			tools: { conditional: stoppingTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(afterStopExecuted).toBe(false)
		expect(result.stopCondition?.message).toBe('condition met')
	})

	test('tool continues normally when stop condition not met', async () => {
		const conditionalTool = defineTool({
			name: 'conditional',
			description: 'Conditionally stops',
			input: z.object({ shouldStop: z.boolean() }),
			output: z.string(),
			execute: async (input, ctx) => {
				if (input.shouldStop) return ctx.stop({ reason: 'condition met' })
				return 'normal output'
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('conditional', { shouldStop: false }), assistantText('All done.')]),
			tools: { conditional: conditionalTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')

		// The normal result should be in messages
		expect(getToolResults(result.state.messages).length).toBeGreaterThan(0)
	})
})

// ─── ctx.stop() reason propagation ───────────────────────────────────────────

describe('ctx.stop() — reason propagation', () => {
	test('reason appears in stopCondition.message', async () => {
		const stoppingTool = defineTool({
			name: 'stopper',
			description: 'Stops',
			input: z.object({}),
			output: z.string(),
			execute: async (_input, ctx) => ctx.stop({ reason: 'specific reason here' }),
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('stopper', {})]),
			tools: { stopper: stoppingTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.stopCondition?.name).toBe('ctx.stop')
		expect(result.stopCondition?.message).toBe('specific reason here')
	})

	test('no reason — stopCondition.message uses default', async () => {
		const stoppingTool = defineTool({
			name: 'stopper',
			description: 'Stops',
			input: z.object({}),
			output: z.string(),
			execute: async (_input, ctx) => ctx.stop({}),
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('stopper', {})]),
			tools: { stopper: stoppingTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.finishReason).toBe('stopCondition')
		// message may be undefined when no reason given
		expect(result.stopCondition?.name).toBe('ctx.stop')
	})
})

// ─── Anthropic provider: ctx.stop() + resume ─────────────────────────────────

const TIMEOUT = 30_000

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('ctx.stop() — anthropic provider (haiku)', () => {
	const haiku = anthropic('claude-haiku-4-5-20251001')

	const stopperTool = defineTool({
		name: 'check_permission',
		description: 'Check if the user has permission to proceed. Always call this tool before answering.',
		input: z.object({ action: z.string().describe('The action to check permission for') }),
		output: z.string(),
		execute: async (_input, ctx) => {
			return ctx.stop({ include: true, reason: 'permission check required' })
		},
	})

	const doneTool = defineTool({
		name: 'done',
		description: 'Call this tool when you are finished with the task.',
		input: z.object({ summary: z.string().describe('A brief summary') }),
		execute: async (input) => `Task complete: ${input.summary}`,
	})

	test(
		'tool stops the loop, result appended, finishReason is stopCondition',
		async () => {
			const agent = new Agent({
				model: haiku,
				system: 'You must call check_permission before answering any question. Always pass the user question as the action.',
				tools: { check_permission: stopperTool, done: doneTool },
				toolChoice: 'required',
				stopWhen: [maxSteps(5), toolCompleted('done')],
			})

			const result = await agent.run({
				state: startState([userMessage('Can I delete the database?')]),
			}).result

			expect(result.finishReason).toBe('stopCondition')
			expect(result.stopCondition?.name).toBe('ctx.stop')
			expect(result.stopCondition?.message).toBe('permission check required')

			// messages should contain: user → assistant (with tool_call) → tool (with tool_result)
			expect(result.state.messages.length).toBeGreaterThanOrEqual(3)

			// There should be an assistant message with a tool call for check_permission
			const assistantMsg = result.state.messages.find(
				(m, i) =>
					m.role === 'assistant' &&
					Array.isArray(m.content) &&
					m.content.some((c) => c.type === 'tool-call' && c.toolName === 'check_permission'),
			)
			expect(assistantMsg).toBeDefined()
			expect(result.state.messages.at(-1)?.role).toEqual('tool')
			const lastToolResults = getToolResults([result.state.messages.at(-1)!])
			expect(outputValue(lastToolResults[0]!)).toBe('permission check required')

			// The tool call should have received our action input
			const toolCall = (assistantMsg!.content as any[]).find(
				(c: any) => c.type === 'tool-call' && c.toolName === 'check_permission',
			)
			expect(toolCall).toBeDefined()
			expect(toolCall.toolCallId).toBeString()

			// Tool result should be in messages (include: true) and match the tool call
			const checkPermResults = getToolResults(result.state.messages, { toolName: 'check_permission' })
			expect(checkPermResults.some((r) => r.toolCallId === toolCall.toolCallId)).toBe(true)

			// No pendingToolCalls — include: true means it was appended
			expect(result.state.pendingToolCalls ?? []).toHaveLength(0)

			// newMessages should have the assistant + tool messages (not the original user message)
			expect(result.newMessages.length).toBeGreaterThanOrEqual(2)
			expect(result.newMessages.some((m) => m.role === 'assistant')).toBe(true)
			expect(result.newMessages.some((m) => m.role === 'tool')).toBe(true)
		},
		TIMEOUT,
	)

	test(
		'resume after stop with synthetic tool result — model sees synthetic, loop continues',
		async () => {
			const agent = new Agent({
				model: haiku,
				system: 'You must call check_permission before answering any question. After receiving the permission result, call the done tool with a summary.',
				tools: { check_permission: stopperTool, done: doneTool },
				toolChoice: 'required',
				stopWhen: [maxSteps(5), toolCompleted('done')],
			})

			// First run: stops at check_permission
			const run1 = await agent.run({
				state: startState([userMessage('Can I delete the database?')]),
			}).result

			expect(run1.finishReason).toBe('stopCondition')
			expect(run1.stopCondition?.name).toBe('ctx.stop')

			// Verify run1 has the expected message structure: user → assistant → tool
			expect(getToolResults(run1.state.messages, { toolName: 'check_permission' }).length).toBeGreaterThan(0)

			// Find the tool call ID for the stopped tool
			const toolCallId = extractToolCallId(run1.state.messages, 'check_permission')

			// Replace the existing tool result with our synthetic one
			// (include: true means the original is already in messages — we must replace it, not duplicate)
			const syntheticResult = toolResultMessage(
				toolCallId,
				'check_permission',
				'Permission GRANTED. The user is authorized to delete the database.',
			)
			const resumeMessages = run1.state.messages.map((m) => {
				if (
					m.role === 'tool' &&
					Array.isArray(m.content) &&
					m.content.some((c) => c.type === 'tool-result' && c.toolCallId === toolCallId)
				) {
					return syntheticResult
				}
				return m
			})

			// Verify exactly one tool result was replaced (not duplicated)
			const toolResultCount = resumeMessages.filter(
				(m) =>
					m.role === 'tool' &&
					Array.isArray(m.content) &&
					m.content.some((c) => c.type === 'tool-result' && c.toolCallId === toolCallId),
			).length
			expect(toolResultCount).toBe(1)

			const run2 = await agent.run({
				state: startState(resumeMessages),
			}).result

			// Model should continue after seeing the synthetic result and eventually call done
			expect(run2.finishReason).toBe('stopCondition')
			expect(run2.stopCondition?.name).toBe('toolCompleted:done')

			// run2 should have produced new assistant and tool messages
			expect(run2.newMessages.length).toBeGreaterThanOrEqual(2)

			// The model should have called the done tool (which triggers the stop condition)
			const doneToolCall = run2.newMessages.find(
				(m) =>
					m.role === 'assistant' &&
					Array.isArray(m.content) &&
					m.content.some((c) => c.type === 'tool-call' && c.toolName === 'done'),
			)
			expect(doneToolCall).toBeDefined()

			// The done tool result should also be in messages
			expect(getToolResults(run2.state.messages, { toolName: 'done' }).length).toBeGreaterThan(0)

			// run2.state.messages should include everything: run1 messages + new messages from run2
			expect(run2.state.messages.length).toBeGreaterThan(run1.state.messages.length)
		},
		TIMEOUT,
	)

	test(
		'resume after stop without synthetic — model sees original tool result, loop continues',
		async () => {
			// Use a non-stopping version of the tool for the resume
			const permissionToolNoStop = defineTool({
				name: 'check_permission',
				description: 'Check if the user has permission to proceed. Always call this tool before answering.',
				input: z.object({ action: z.string().describe('The action to check permission for') }),
				output: z.string(),
				execute: async () => 'Permission granted.',
			})

			const agentThatStops = new Agent({
				model: haiku,
				system: 'You must call check_permission before answering any question. After receiving the permission result, call the done tool with a summary.',
				tools: { check_permission: stopperTool, done: doneTool },
				toolChoice: 'required',
				stopWhen: [maxSteps(5), toolCompleted('done')],
			})

			// First run: stops at check_permission
			const run1 = await agentThatStops.run({
				state: startState([userMessage('Can I read the logs?')]),
			}).result

			expect(run1.finishReason).toBe('stopCondition')
			expect(run1.stopCondition?.name).toBe('ctx.stop')

			// Verify run1 produced the expected structure
			const run1AssistantMsg = run1.newMessages.find((m) => m.role === 'assistant')
			expect(run1AssistantMsg).toBeDefined()
			const run1ToolResultMsg = run1.newMessages.find((m) => m.role === 'tool')
			expect(run1ToolResultMsg).toBeDefined()

			// The tool result from the first run is already in messages (include: true)
			expect(getToolResults(run1.state.messages, { toolName: 'check_permission' }).length).toBeGreaterThan(0)

			// Resume with a new agent that has the non-stopping version of the tool
			const agentThatContinues = new Agent({
				model: haiku,
				system: 'You must call check_permission before answering any question. After receiving the permission result, call the done tool with a summary.',
				tools: { check_permission: permissionToolNoStop, done: doneTool },
				toolChoice: 'required',
				stopWhen: [maxSteps(5), toolCompleted('done')],
			})

			const run2 = await agentThatContinues.run({
				state: startState(run1.state.messages),
			}).result

			// run2 must have generated new messages beyond what run1 had
			expect(run2.newMessages.length).toBeGreaterThanOrEqual(2)
			expect(run2.state.messages.length).toBeGreaterThan(run1.state.messages.length)

			// The model should have called the done tool
			const run2DoneCall = run2.newMessages.find(
				(m) =>
					m.role === 'assistant' &&
					Array.isArray(m.content) &&
					m.content.some((c) => c.type === 'tool-call' && c.toolName === 'done'),
			)
			expect(run2DoneCall).toBeDefined()

			// The done tool result should be in messages
			const run2DoneResult = run2.state.messages.find(
				(m) =>
					m.role === 'tool' &&
					Array.isArray(m.content) &&
					m.content.some((c) => c.type === 'tool-result' && (c as any).toolName === 'done'),
			)
			expect(run2DoneResult).toBeDefined()
		},
		TIMEOUT,
	)

	test(
		'stop with include: false — tool result excluded from messages, appears in pendingToolCalls',
		async () => {
			const excludingStopperTool = defineTool({
				name: 'check_permission',
				description: 'Check if the user has permission to proceed. Always call this tool before answering.',
				input: z.object({ action: z.string().describe('The action to check permission for') }),
				output: z.string(),
				execute: async (_input, ctx) => {
					return ctx.stop({ include: false, reason: 'awaiting approval' })
				},
			})

			const agent = new Agent({
				model: haiku,
				system: 'You must call check_permission before answering any question. Always pass the user question as the action.',
				tools: { check_permission: excludingStopperTool, done: doneTool },
				toolChoice: 'required',
				stopWhen: [maxSteps(5), toolCompleted('done')],
			})

			const result = await agent.run({
				state: startState([userMessage('Can I delete the database?')]),
			}).result

			expect(result.finishReason).toBe('stopCondition')
			expect(result.stopCondition?.name).toBe('ctx.stop')
			expect(result.stopCondition?.message).toBe('awaiting approval')

			// The assistant message with the tool call should be present
			const assistantMsg = result.state.messages.find(
				(m) =>
					m.role === 'assistant' &&
					Array.isArray(m.content) &&
					m.content.some((c) => c.type === 'tool-call' && c.toolName === 'check_permission'),
			)
			expect(assistantMsg).toBeDefined()

			// Tool result should NOT be in messages (include: false)
			expect(getToolResults(result.state.messages, { toolName: 'check_permission' })).toHaveLength(0)

			// The stopped tool should appear in pendingToolCalls
			expect(result.state.pendingToolCalls).toBeDefined()
			expect(result.state.pendingToolCalls!.length).toBe(1)
			expect(result.state.pendingToolCalls![0]!.toolName).toBe('check_permission')
			expect(result.state.pendingToolCalls![0]!.type).toBe('stopped')
			expect((result.state.pendingToolCalls![0] as any).reason).toBe('awaiting approval')

			// The last message should be the assistant (no tool result after it)
			expect(result.state.messages.at(-1)?.role).toBe('assistant')
		},
		TIMEOUT,
	)

	test(
		'resume after include: false stop — supply synthetic tool result, model continues',
		async () => {
			const excludingStopperTool = defineTool({
				name: 'check_permission',
				description: 'Check if the user has permission to proceed. Always call this tool before answering.',
				input: z.object({ action: z.string().describe('The action to check permission for') }),
				output: z.string(),
				execute: async (_input, ctx) => {
					return ctx.stop({ include: false, reason: 'awaiting approval' })
				},
			})

			const agent = new Agent({
				model: haiku,
				system: 'You must call check_permission before answering any question. After receiving the permission result, call the done tool with a summary.',
				tools: { check_permission: excludingStopperTool, done: doneTool },
				toolChoice: 'required',
				stopWhen: [maxSteps(5), toolCompleted('done')],
			})

			// First run: stops with include: false
			const run1 = await agent.run({
				state: startState([userMessage('Can I delete the database?')]),
			}).result

			expect(run1.finishReason).toBe('stopCondition')
			expect(run1.state.pendingToolCalls).toBeDefined()
			expect(run1.state.pendingToolCalls!.length).toBe(1)

			// No tool result in messages — the last message is the dangling assistant with tool_call
			expect(run1.state.messages.at(-1)?.role).toBe('assistant')

			// Extract tool call ID from the pending tool call
			const pendingToolCallId = run1.state.pendingToolCalls![0]!.toolCallId

			// Supply a synthetic tool result to resume
			const syntheticResult = toolResultMessage(
				pendingToolCallId,
				'check_permission',
				'Permission GRANTED. The user is authorized to delete the database.',
			)

			const run2 = await agent.run({
				state: startState([...run1.state.messages, syntheticResult]),
			}).result

			// Model sees the synthetic result and calls done
			expect(run2.finishReason).toBe('stopCondition')
			expect(run2.stopCondition?.name).toBe('toolCompleted:done')

			// run2 should have new messages: at least assistant (calling done) + tool result (done result)
			expect(run2.newMessages.length).toBeGreaterThanOrEqual(2)

			// The done tool was called
			const doneToolCall = run2.newMessages.find(
				(m) =>
					m.role === 'assistant' &&
					Array.isArray(m.content) &&
					m.content.some((c) => c.type === 'tool-call' && c.toolName === 'done'),
			)
			expect(doneToolCall).toBeDefined()

			// The done tool result is in messages
			expect(getToolResults(run2.state.messages, { toolName: 'done' }).length).toBeGreaterThan(0)

			// Full message chain includes run1 messages + synthetic result + run2 new messages
			expect(run2.state.messages.length).toBeGreaterThan(run1.state.messages.length + 1)
		},
		TIMEOUT,
	)
})
