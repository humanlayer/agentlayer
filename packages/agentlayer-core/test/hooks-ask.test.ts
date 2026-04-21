/**
 * Tests for preToolUse hooks — ctx.ask() and mixed batch (ask + allowed)
 *
 * Validates that:
 * - ctx.ask() stops loop with finishReason: 'approvalRequired' and pendingToolCalls
 * - pendingToolCall has the approval request with message
 * - approval id defaults to toolCallId
 * - custom approval id is preserved
 * - mixed batch: allowed tools execute immediately, ask tool becomes pending
 * - ask/allow/ask pattern: 2 pending, 1 executed
 */

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { ApprovalHook } from '../src'
import { Agent, defineTool, startState } from '../src'
import { assistantWithToolCall, assistantWithToolCalls, getToolResults, mockModel, userMessage } from './mocks'

describe('approval — ctx.ask()', () => {
	test('stops loop with finishReason: approvalRequired and pendingToolCalls', async () => {
		let toolExecuted = false

		const deployTool = defineTool({
			name: 'deploy',
			description: 'Deploy to production',
			input: z.object({ env: z.string() }),
			output: z.string(),
			execute: async (input) => {
				toolExecuted = true
				return `Deployed to ${input.env}`
			},
		})

		const askHook: ApprovalHook = (ctx) => ctx.ask({ message: 'Approval required to deploy' })

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('deploy', { env: 'production' })]),
			tools: { deploy: deployTool },
			hooks: { approval: [askHook] },
		})

		const result = await agent.run({ state: startState([userMessage('deploy please')]) }).result

		// Tool should NOT have executed
		expect(toolExecuted).toBe(false)
		expect(result.finishReason).toBe('approvalRequired')

		// Should have pending tool calls
		expect(result.state.pendingToolCalls).toBeDefined()
		expect(result.state.pendingToolCalls!.length).toBe(1)

		const pending = result.state.pendingToolCalls![0]!
		expect(pending.type).toBe('approval')
		expect(pending.toolName).toBe('deploy')
		expect(pending.toolCallId).toBeDefined()
	})

	test('pendingToolCall has the approval request with message', async () => {
		const deployTool = defineTool({
			name: 'deploy',
			description: 'Deploy to production',
			input: z.object({ env: z.string() }),
			execute: async (input) => `Deployed to ${input.env}`,
		})

		const askHook: ApprovalHook = (ctx) =>
			ctx.ask({
				message: 'Please approve this deployment',
				metadata: { environment: ctx.input.env },
			})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('deploy', { env: 'staging' })]),
			tools: { deploy: deployTool },
			hooks: { approval: [askHook] },
		})

		const result = await agent.run({ state: startState([userMessage('deploy please')]) }).result

		expect(result.finishReason).toBe('approvalRequired')
		const pending = result.state.pendingToolCalls![0]! as any
		expect(pending.type).toBe('approval')
		expect(pending.approval.message).toBe('Please approve this deployment')
		expect(pending.approval.metadata?.environment).toBe('staging')
	})

	test('approval id defaults to toolCallId when not specified', async () => {
		const deployTool = defineTool({
			name: 'deploy',
			description: 'Deploy',
			input: z.object({}),
			execute: async () => 'deployed',
		})

		const askHook: ApprovalHook = (ctx) => ctx.ask({})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('deploy', {})]),
			tools: { deploy: deployTool },
			hooks: { approval: [askHook] },
		})

		const result = await agent.run({ state: startState([userMessage('deploy')]) }).result

		const pending = result.state.pendingToolCalls![0]! as any
		expect(pending.approval.id).toBe(pending.toolCallId)
	})

	test('custom approval id is preserved', async () => {
		const deployTool = defineTool({
			name: 'deploy',
			description: 'Deploy',
			input: z.object({}),
			execute: async () => 'deployed',
		})

		const askHook: ApprovalHook = (ctx) => ctx.ask({ id: 'custom-approval-id' })

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('deploy', {})]),
			tools: { deploy: deployTool },
			hooks: { approval: [askHook] },
		})

		const result = await agent.run({ state: startState([userMessage('deploy')]) }).result

		const pending = result.state.pendingToolCalls![0]! as any
		expect(pending.approval.id).toBe('custom-approval-id')
	})
})

describe('approval — mixed batch (ask + allowed)', () => {
	test('allowed tools execute immediately, ask tool becomes pending', async () => {
		let echoExecuted = false
		let deployExecuted = false

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => {
				echoExecuted = true
				return input.text
			},
		})

		const deployTool = defineTool({
			name: 'deploy',
			description: 'Deploys',
			input: z.object({ env: z.string() }),
			output: z.string(),
			execute: async (input) => {
				deployExecuted = true
				return `Deployed to ${input.env}`
			},
		})

		// Only ask for deploy, allow everything else
		const askDeployHook: ApprovalHook = (ctx) => {
			if (ctx.toolName === 'deploy') {
				return ctx.ask({ message: 'Approve deploy?' })
			}
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'echo', input: { text: 'hello' } },
					{ toolName: 'deploy', input: { env: 'production' } },
					{ toolName: 'echo', input: { text: 'world' } },
				),
			]),
			tools: { echo: echoTool, deploy: deployTool },
			hooks: { approval: [askDeployHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('approvalRequired')

		// echo should have executed (both instances)
		expect(echoExecuted).toBe(true)
		// deploy should NOT have executed
		expect(deployExecuted).toBe(false)

		// Only deploy should be in pendingToolCalls
		expect(result.state.pendingToolCalls).toBeDefined()
		expect(result.state.pendingToolCalls!.length).toBe(1)
		expect(result.state.pendingToolCalls![0]!.toolName).toBe('deploy')
		expect(result.state.pendingToolCalls![0]!.type).toBe('approval')

		// echo results should be in messages
		expect(getToolResults(result.state.messages, { toolName: 'echo' })).toHaveLength(2)

		// deploy result should NOT be in messages
		expect(getToolResults(result.state.messages, { toolName: 'deploy' })).toHaveLength(0)
	})

	test('3 tool calls: ask/allow/ask pattern → 2 pending, 1 executed', async () => {
		let executeCount = 0

		const tool = defineTool({
			name: 'tool',
			description: 'A tool',
			input: z.object({ n: z.number() }),
			output: z.string(),
			execute: async (input) => {
				executeCount++
				return `result-${input.n}`
			},
		})

		// Asks for odd numbers, allows even
		const hook: ApprovalHook = (ctx) => {
			const n = (ctx.input as any).n as number
			if (n % 2 !== 0) return ctx.ask({ message: `Approve odd: ${n}` })
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'tool', input: { n: 1 } }, // ask
					{ toolName: 'tool', input: { n: 2 } }, // allow
					{ toolName: 'tool', input: { n: 3 } }, // ask
				),
			]),
			tools: { tool },
			hooks: { approval: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('approvalRequired')
		expect(executeCount).toBe(1) // only n=2 executed
		expect(result.state.pendingToolCalls).toBeDefined()
		expect(result.state.pendingToolCalls!.length).toBe(2)

		const pendingNs = result.state.pendingToolCalls!.map((p) => (p.input as any).n)
		expect(pendingNs).toContain(1)
		expect(pendingNs).toContain(3)
	})
})
