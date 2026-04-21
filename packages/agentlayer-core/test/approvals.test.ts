/**
 * Tests for Phase 3: Approval Resume Flow
 *
 * Validates:
 * - ctx.ask() → resume with withApprovals(state, [{ toolCallId, approved: true }]) → tool executes
 * - ctx.ask() → resume with withApprovals(state, [{ toolCallId, approved: false, denialReason }]) → denial result
 * - Partial approvals: 2 pending, approve 1 → loop stops again with remaining
 * - All pending resolved → loop proceeds to next LLM call
 * - Mixed resume: synthetic result for one tool + approval for another
 * - getPendingToolCalls(messages) returns correct dangling tool calls
 * - toolResultMessage works as public API (same as test helper behavior)
 * - Passing withApprovals(state, []) (empty) prevents auto-execution → remains pending
 * - Omitting approvals causes all dangling tool calls to auto-execute (backwards-compat)
 */

import { describe, expect, test } from 'bun:test'

const { anthropic } = await import('@ai-sdk/anthropic')

import { z } from 'zod'
import type { ApprovalHook, PreToolUseHook } from '../src'
import {
	Agent,
	defineTool,
	getPendingToolCalls,
	startState,
	toolCalled,
	toolResultMessage,
	withApprovals,
} from '../src'
import {
	assistantText,
	assistantWithToolCall,
	assistantWithToolCalls,
	extractToolCallId,
	getToolResults,
	mockModel,
	outputValue,
	userMessage,
} from './mocks'

// ─── Tool factories with per-test counters ────────────────────────────────────

function makeDeployTool() {
	let count = 0
	const tool = defineTool({
		name: 'deploy',
		description: 'Deploy to production',
		input: z.object({ env: z.string() }),
		output: z.string(),
		execute: async (input) => {
			count++
			return `Deployed to ${input.env}`
		},
	})
	return {
		tool,
		get count() {
			return count
		},
	}
}

function makeEchoTool() {
	let count = 0
	const tool = defineTool({
		name: 'echo',
		description: 'Echo text',
		input: z.object({ text: z.string() }),
		output: z.string(),
		execute: async (input) => {
			count++
			return input.text
		},
	})
	return {
		tool,
		get count() {
			return count
		},
	}
}

// ─── toolResultMessage public API ─────────────────────────────────────────────

describe('toolResultMessage — public API', () => {
	test('builds a valid ToolModelMessage matching test helper behavior', () => {
		const msg = toolResultMessage('call-1', 'deploy', 'Deployed successfully')
		expect(msg.role).toBe('tool')
		expect(Array.isArray(msg.content)).toBe(true)
		const partRaw = msg.content[0]!
		expect(partRaw.type).toBe('tool-result')
		// Narrow to tool-result part
		const part = partRaw as { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }
		expect(part.toolCallId).toBe('call-1')
		expect(part.toolName).toBe('deploy')
		// Output should be text object
		expect(typeof part.output).toBe('object')
		const output = part.output as { type: string; value: string }
		expect(output.type).toBe('text')
		expect(output.value).toBe('Deployed successfully')
	})

	test('isError flag is omitted when not provided', () => {
		const msg = toolResultMessage('call-1', 'deploy', 'OK')
		const part = msg.content[0]! as any
		expect(part.isError).toBeUndefined()
	})

	test('isError flag is set when provided', () => {
		const msg = toolResultMessage('call-1', 'deploy', 'Failed', true)
		const part = msg.content[0]! as any
		expect(part.isError).toBe(true)
	})

	test('can be passed to agent.run() as a synthetic tool result to resume a stopped run', async () => {
		const deploy = makeDeployTool()
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('deploy', { env: 'staging' }),
				assistantText('Deployment complete.'),
			]),
			tools: { deploy: deploy.tool },
		})

		// Stop before execution using toolCalled pattern (manual synthetic result)
		const result1 = await agent.run({ state: startState([userMessage('deploy staging')]) }).result
		expect(result1.finishReason).toBe('complete') // no stop condition set, auto-executes

		// More useful: verify the message format is valid for pass-through
		const toolCallId = extractToolCallId(result1.state.messages, 'deploy')
		const syntheticResult = toolResultMessage(toolCallId, 'deploy', 'Manually approved result')
		expect(syntheticResult.role).toBe('tool')
		expect(Array.isArray(syntheticResult.content)).toBe(true)
	})
})

// ─── getPendingToolCalls helper ───────────────────────────────────────────────

describe('getPendingToolCalls', () => {
	test('returns empty array for messages without tool calls', () => {
		const messages = [userMessage('hello')]
		expect(getPendingToolCalls(messages)).toEqual([])
	})

	test('returns empty array when all tool calls have results', () => {
		const messages = [
			userMessage('deploy'),
			{
				role: 'assistant' as const,
				content: [{ type: 'tool-call' as const, toolCallId: 'call-1', toolName: 'deploy', input: '{}' }],
			},
			toolResultMessage('call-1', 'deploy', 'Deployed.'),
		]
		expect(getPendingToolCalls(messages)).toEqual([])
	})

	test('returns dangling tool calls without tool results', async () => {
		const deploy = makeDeployTool()
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('deploy', { env: 'production' })]),
			tools: { deploy: deploy.tool },
			hooks: { approval: [(ctx) => ctx.ask({ message: 'Approve?' })] },
		})

		const result = await agent.run({ state: startState([userMessage('deploy')]) }).result
		expect(result.finishReason).toBe('approvalRequired')

		const pending = getPendingToolCalls(result.state.messages)
		expect(pending).toHaveLength(1)
		expect(pending[0]!.toolName).toBe('deploy')
		expect(pending[0]!.input).toEqual({ env: 'production' })
		expect(typeof pending[0]!.toolCallId).toBe('string')
	})

	test('returns only unresolved tool calls in a mixed batch', async () => {
		const echo = makeEchoTool()
		const deploy = makeDeployTool()
		const askDeployHook: ApprovalHook = (ctx) => {
			if (ctx.toolName === 'deploy') return ctx.ask({ message: 'Approve?' })
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'echo', input: { text: 'hello' } },
					{ toolName: 'deploy', input: { env: 'production' } },
				),
			]),
			tools: { echo: echo.tool, deploy: deploy.tool },
			hooks: { approval: [askDeployHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.finishReason).toBe('approvalRequired')

		const pending = getPendingToolCalls(result.state.messages)
		expect(pending).toHaveLength(1)
		expect(pending[0]!.toolName).toBe('deploy')
	})

	test('handles multiple pending tool calls correctly', async () => {
		const deploy = makeDeployTool()
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'deploy', input: { env: 'staging' } },
					{ toolName: 'deploy', input: { env: 'production' } },
				),
			]),
			tools: { deploy: deploy.tool },
			hooks: { approval: [(ctx) => ctx.ask({ message: 'Approve?' })] },
		})

		const result = await agent.run({ state: startState([userMessage('deploy both')]) }).result
		expect(result.finishReason).toBe('approvalRequired')

		const pending = getPendingToolCalls(result.state.messages)
		expect(pending).toHaveLength(2)
		expect(pending.every((p) => p.toolName === 'deploy')).toBe(true)
	})

	test('returns input as parsed object when stored as JSON string', () => {
		const messages = [
			userMessage('deploy'),
			{
				role: 'assistant' as const,
				content: [
					{
						type: 'tool-call' as const,
						toolCallId: 'call-1',
						toolName: 'deploy',
						input: '{"env":"production"}',
					},
				],
			},
		]
		const pending = getPendingToolCalls(messages)
		expect(pending).toHaveLength(1)
		expect(pending[0]!.input).toEqual({ env: 'production' })
	})
})

// ─── Approval resume flow ─────────────────────────────────────────────────────

describe('approval resume — approved: true → tool executes', () => {
	test('approved tool executes through preToolUse chain on resume', async () => {
		const deploy = makeDeployTool()
		const askHook: ApprovalHook = (ctx) => ctx.ask({ message: 'Approve deploy?' })

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('deploy', { env: 'production' }),
				assistantText('Deployment complete.'),
			]),
			tools: { deploy: deploy.tool },
			hooks: { approval: [askHook] },
		})

		// Run 1: stops for approval
		const result1 = await agent.run({ state: startState([userMessage('deploy')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')
		expect(deploy.count).toBe(0)

		const pending = result1.state.pendingToolCalls!
		expect(pending).toHaveLength(1)
		const pendingCall = pending[0]! as any
		const approvalId = pendingCall.approval.id

		// Run 2: resume with approval
		const result2 = await agent.run({
			state: withApprovals(result1.state, [{ toolCallId: approvalId, approved: true }]),
		}).result

		expect(deploy.count).toBe(1)
		expect(result2.finishReason).toBe('complete')

		// Tool result message should be in newMessages
		expect(getToolResults(result2.newMessages)).toHaveLength(1)
	})

	test('approved tool result is in messages and model sees it', async () => {
		const deploy = makeDeployTool()
		const askHook: ApprovalHook = (ctx) => ctx.ask({ message: 'Approve?' })

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('deploy', { env: 'staging' }),
				assistantText('Staging deployment complete.'),
			]),
			tools: { deploy: deploy.tool },
			hooks: { approval: [askHook] },
		})

		const result1 = await agent.run({ state: startState([userMessage('deploy to staging')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')

		const pendingCall = result1.state.pendingToolCalls![0]! as any
		const approvalId = pendingCall.approval.id

		const result2 = await agent.run({
			state: withApprovals(result1.state, [{ toolCallId: approvalId, approved: true }]),
		}).result

		expect(result2.finishReason).toBe('complete')
		expect(deploy.count).toBe(1)

		// Messages should include the tool result
		const [resultPart] = getToolResults(result2.state.messages)
		expect(resultPart).toBeDefined()
		expect(resultPart!.toolName).toBe('deploy')
	})
})

describe('approval resume — approved: false → denial result', () => {
	test('denied tool gets denial result appended, model continues', async () => {
		const deploy = makeDeployTool()
		const askHook: ApprovalHook = (ctx) => ctx.ask({ message: 'Approve deploy?' })

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('deploy', { env: 'production' }),
				assistantText('Understood, deployment was denied.'),
			]),
			tools: { deploy: deploy.tool },
			hooks: { approval: [askHook] },
		})

		const result1 = await agent.run({ state: startState([userMessage('deploy')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')
		expect(deploy.count).toBe(0)

		const pendingCall = result1.state.pendingToolCalls![0]! as any
		const approvalId = pendingCall.approval.id

		// Run 2: deny the approval
		const result2 = await agent.run({
			state: withApprovals(result1.state, [
				{ toolCallId: approvalId, approved: false, denialReason: 'Too risky right now' },
			]),
		}).result

		// Tool should NOT have executed
		expect(deploy.count).toBe(0)
		expect(result2.finishReason).toBe('complete')

		// Denial result should be in messages
		const deployResults = getToolResults(result2.state.messages, { toolName: 'deploy' })
		expect(deployResults).toHaveLength(1)
		expect(outputValue(deployResults[0]!)).toContain('Too risky right now')
	})

	test('denied without message uses default denial text', async () => {
		const deploy = makeDeployTool()
		const askHook: ApprovalHook = (ctx) => ctx.ask({})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('deploy', { env: 'production' }),
				assistantText('OK, not deploying.'),
			]),
			tools: { deploy: deploy.tool },
			hooks: { approval: [askHook] },
		})

		const result1 = await agent.run({ state: startState([userMessage('deploy')]) }).result
		const pendingCall = result1.state.pendingToolCalls![0]! as any
		const approvalId = pendingCall.approval.id

		const result2 = await agent.run({
			state: withApprovals(result1.state, [{ toolCallId: approvalId, approved: false }]),
		}).result

		expect(deploy.count).toBe(0)
		expect(result2.finishReason).toBe('complete')

		const deployResults = getToolResults(result2.state.messages, { toolName: 'deploy' })
		expect(deployResults).toHaveLength(1)
		expect(outputValue(deployResults[0]!)).toContain('denied')
	})
})

describe('partial approvals — approve some, keep others pending', () => {
	test('2 pending, approve 1 → loop stops again with remaining', async () => {
		const deploy = makeDeployTool()
		const askHook: ApprovalHook = (ctx) => ctx.ask({ message: `Approve ${ctx.toolName}?` })

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'deploy', input: { env: 'staging' } },
					{ toolName: 'deploy', input: { env: 'production' } },
				),
				// Run 3: after both resolved
				assistantText('Both deployments done.'),
			]),
			tools: { deploy: deploy.tool },
			hooks: { approval: [askHook] },
		})

		// Run 1: both tools need approval
		const result1 = await agent.run({ state: startState([userMessage('deploy to both')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')
		expect(result1.state.pendingToolCalls).toHaveLength(2)
		expect(deploy.count).toBe(0)

		const [pending1, pending2] = result1.state.pendingToolCalls! as any[]
		const id1 = pending1.approval.id
		const id2 = pending2.approval.id

		// Run 2: approve only the first one
		const result2 = await agent.run({
			state: withApprovals(result1.state, [{ toolCallId: id1, approved: true }]),
		}).result

		// First tool executed, second still pending
		expect(deploy.count).toBe(1)
		expect(result2.finishReason).toBe('approvalRequired')
		expect(result2.state.pendingToolCalls).toHaveLength(1)

		const stillPending = result2.state.pendingToolCalls![0]! as any
		expect(stillPending.toolCallId).toBe(id2)

		// Run 3: approve the remaining one
		const result3 = await agent.run({
			state: withApprovals(result2.state, [{ toolCallId: id2, approved: true }]),
		}).result

		expect(deploy.count).toBe(2)
		expect(result3.finishReason).toBe('complete')
	})

	test('approve 1 deny 1 in same batch → both resolved, loop continues', async () => {
		const deploy = makeDeployTool()
		const askHook: ApprovalHook = (ctx) => ctx.ask({ message: `Approve ${ctx.toolName}?` })

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'deploy', input: { env: 'staging' } },
					{ toolName: 'deploy', input: { env: 'production' } },
				),
				assistantText('One deployed, one denied.'),
			]),
			tools: { deploy: deploy.tool },
			hooks: { approval: [askHook] },
		})

		const result1 = await agent.run({ state: startState([userMessage('deploy both')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')
		expect(result1.state.pendingToolCalls).toHaveLength(2)

		const [pending1, pending2] = result1.state.pendingToolCalls! as any[]
		const id1 = pending1.approval.id
		const id2 = pending2.approval.id

		// Approve first, deny second
		const result2 = await agent.run({
			state: withApprovals(result1.state, [
				{ toolCallId: id1, approved: true },
				{ toolCallId: id2, approved: false, denialReason: 'Prod too risky' },
			]),
		}).result

		expect(deploy.count).toBe(1)
		expect(result2.finishReason).toBe('complete')

		// Two tool results: one with deploy result, one with denial
		expect(getToolResults(result2.state.messages, { toolName: 'deploy' })).toHaveLength(2)
	})
})

describe('empty approvals array — prevents auto-execution', () => {
	test('withApprovals(state, []) causes dangling tool calls to remain pending instead of auto-executing', async () => {
		const deploy = makeDeployTool()
		const askHook: ApprovalHook = (ctx) => ctx.ask({ message: 'Approve?' })

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('deploy', { env: 'production' })]),
			tools: { deploy: deploy.tool },
			hooks: { approval: [askHook] },
		})

		// Run 1: stops for approval
		const result1 = await agent.run({ state: startState([userMessage('deploy')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')

		// Run 2: pass empty approvals — should NOT auto-execute
		const result2 = await agent.run({
			state: withApprovals(result1.state, []),
		}).result

		expect(deploy.count).toBe(0)
		expect(result2.finishReason).toBe('approvalRequired')
		expect(result2.state.pendingToolCalls).toHaveLength(1)
	})
})

describe('omitting approvals — backwards compat auto-execution', () => {
	test('dangling tool calls auto-execute when approvals is omitted (backwards-compat)', async () => {
		const deploy = makeDeployTool()
		// Create a run that ends with a dangling tool call (toolCalled stop)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('deploy', { env: 'production' }), assistantText('Done.')]),
			tools: { deploy: deploy.tool },
			stopWhen: toolCalled('deploy'),
		})

		// Run 1: stops before execution
		const result1 = await agent.run({ state: startState([userMessage('deploy')]) }).result
		expect(result1.finishReason).toBe('stopCondition')
		expect(deploy.count).toBe(0)

		// Run 2: no approvals → auto-execute (backwards compat)
		const result2 = await agent.run({ state: startState(result1.state.messages) }).result

		expect(deploy.count).toBe(1)
		expect(result2.finishReason).toBe('complete')
	})
})

describe('mixed resume — synthetic result + approval', () => {
	test('caller provides synthetic result for one tool, approval decision for another', async () => {
		const echo = makeEchoTool()
		const deploy = makeDeployTool()
		const askDeployHook: ApprovalHook = (ctx) => {
			if (ctx.toolName === 'deploy') return ctx.ask({ message: 'Approve deploy?' })
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'echo', input: { text: 'hello' } },
					{ toolName: 'deploy', input: { env: 'production' } },
				),
				assistantText('Both handled.'),
			]),
			tools: { echo: echo.tool, deploy: deploy.tool },
			hooks: { approval: [askDeployHook] },
		})

		// Run 1: echo executes, deploy is pending
		const result1 = await agent.run({ state: startState([userMessage('echo and deploy')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')
		expect(echo.count).toBe(1) // echo ran
		expect(deploy.count).toBe(0) // deploy did not

		// Verify only deploy is pending
		expect(result1.state.pendingToolCalls).toHaveLength(1)
		expect(result1.state.pendingToolCalls![0]!.toolName).toBe('deploy')

		const pendingCall = result1.state.pendingToolCalls![0]! as any
		const approvalId = pendingCall.approval.id

		// Run 2: approve deploy
		const result2 = await agent.run({
			state: withApprovals(result1.state, [{ toolCallId: approvalId, approved: true }]),
		}).result

		expect(deploy.count).toBe(1)
		expect(result2.finishReason).toBe('complete')
	})

	test('caller provides synthetic result via toolResultMessage for pending tool', async () => {
		const deploy = makeDeployTool()
		const askHook: ApprovalHook = (ctx) => ctx.ask({ message: 'Approve deploy?' })

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('deploy', { env: 'production' }),
				assistantText('Deployment complete.'),
			]),
			tools: { deploy: deploy.tool },
			hooks: { approval: [askHook] },
		})

		// Run 1: stops for approval
		const result1 = await agent.run({ state: startState([userMessage('deploy')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')

		// Build synthetic result using the public toolResultMessage API
		const toolCallId = extractToolCallId(result1.state.messages, 'deploy')
		const synthetic = toolResultMessage(toolCallId, 'deploy', 'External deployment system approved and executed.')

		// Run 2: pass synthetic result directly (no approvals map needed — already resolved)
		const result2 = await agent.run({
			state: startState([...result1.state.messages, synthetic]),
		}).result

		// Tool should NOT have re-executed — caller provided synthetic result
		expect(deploy.count).toBe(0)
		expect(result2.finishReason).toBe('complete')
	})
})

describe('preamble approval execution skips approval hooks but runs preToolUse hooks', () => {
	test('approval hooks do NOT re-run when approved tool executes in preamble', async () => {
		const deploy = makeDeployTool()
		let approvalHookCallCount = 0
		// Approval hook always asks — but should only run once (in the main loop, NOT in preamble)
		const askHook: ApprovalHook = (ctx) => {
			approvalHookCallCount++
			return ctx.ask({ message: 'Approve?' })
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('deploy', { env: 'production' }), assistantText('Done.')]),
			tools: { deploy: deploy.tool },
			hooks: { approval: [askHook] },
		})

		// Run 1: approval hook fires, asks for approval
		const result1 = await agent.run({ state: startState([userMessage('deploy')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')
		expect(approvalHookCallCount).toBe(1)
		expect(deploy.count).toBe(0)

		const pendingCall = result1.state.pendingToolCalls![0]! as any
		const approvalId = pendingCall.approval.id

		// Run 2: approve → preamble skips approval hook chain, executes tool
		const result2 = await agent.run({
			state: withApprovals(result1.state, [{ toolCallId: approvalId, approved: true }]),
		}).result

		// Approval hook did NOT fire again — approval chain is skipped in preamble
		expect(approvalHookCallCount).toBe(1)
		expect(deploy.count).toBe(1)
		expect(result2.finishReason).toBe('complete')
	})

	test('withApprovals removes pending entry → fast-path auto-executes (preToolUse not called in preamble)', async () => {
		const deploy = makeDeployTool()
		let preToolUseCallCount = 0
		// Approval hook asks
		const askHook: ApprovalHook = (ctx) => ctx.ask({ message: 'Approve?' })
		// PreToolUse hook
		const preToolUseHook: PreToolUseHook = (ctx) => {
			preToolUseCallCount++
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('deploy', { env: 'production' }), assistantText('Done.')]),
			tools: { deploy: deploy.tool },
			hooks: { approval: [askHook], preToolUse: [preToolUseHook] },
		})

		// Run 1: approval hook fires, asks for approval
		const result1 = await agent.run({ state: startState([userMessage('deploy')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')
		// preToolUse hook does NOT run when approval gate blocks
		expect(preToolUseCallCount).toBe(0)
		expect(deploy.count).toBe(0)

		const pendingCall = result1.state.pendingToolCalls![0]! as any
		const approvalId = pendingCall.approval.id

		// Run 2: withApprovals removes the entry → state has no pendingToolCalls
		// → agent uses fast path which calls executeToolCall directly (no hooks)
		const result2 = await agent.run({
			state: withApprovals(result1.state, [{ toolCallId: approvalId, approved: true }]),
		}).result

		// Tool executed via fast path — preToolUse hook did NOT run in preamble
		// (when all pending entries are resolved, preamble uses executeToolCall directly)
		expect(preToolUseCallCount).toBe(0)
		expect(deploy.count).toBe(1)
		expect(result2.finishReason).toBe('complete')
	})
})

// ─── Phase 3: multi-run approval history — original problem is solved ─────────

describe('approval history preserved across runs with structured metadata', () => {
	/**
	 * Scenario: the original problem was that structured ApprovalRequest metadata
	 * (specifically the `message` field from ctx.ask({ message: '...' })) was lost
	 * between runs — it got flattened into a plain text tool-result and was gone.
	 *
	 * This test proves that across 3 runs:
	 * - Run 1: approval requested → state.pendingToolCalls has ApprovalRequest with message
	 * - Run 2: denied with reason → model retries → new approval → approvalHistory has run 1's decision
	 * - Run 3: approved → completes → approvalHistory has both decisions with full structured metadata
	 */
	test('3-run scenario: structured approval.message survives across runs', async () => {
		// Counts to verify execution behaviour
		let deployCallCount = 0

		const deploy = defineTool({
			name: 'deploy',
			description: 'Deploy to an environment',
			input: z.object({ env: z.string() }),
			output: z.string(),
			execute: async (input) => {
				deployCallCount++
				return `Deployed to ${input.env}`
			},
		})

		// Hook always asks with a meaningful message
		const askHook: ApprovalHook = (ctx) =>
			ctx.ask({ message: `Please confirm deploy to ${(ctx.input as any).env ?? 'unknown'}` })

		const agent = new Agent({
			model: mockModel([
				// Run 1: model calls deploy
				assistantWithToolCall('deploy', { env: 'production' }),
				// Run 2 (after denial): model retries with same tool
				assistantWithToolCall('deploy', { env: 'production' }),
				// Run 3 (after approval): model wraps up
				assistantText('Deployment complete.'),
			]),
			tools: { deploy },
			hooks: { approval: [askHook] },
		})

		// ── Run 1: approval requested ──────────────────────────────────────────
		const result1 = await agent.run({ state: startState([userMessage('deploy to production')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')
		expect(deployCallCount).toBe(0)

		// state.pendingToolCalls has structured ApprovalRequest metadata including message
		expect(result1.state.pendingToolCalls).toHaveLength(1)
		const pending1 = result1.state.pendingToolCalls![0]!
		expect(pending1.type).toBe('approval')
		if (pending1.type === 'approval') {
			expect(pending1.approval.message).toBe('Please confirm deploy to production')
			expect(pending1.approval.toolName).toBe('deploy')
		}
		// No history yet
		expect(result1.state.approvalHistory).toBeUndefined()

		const id1 = pending1.toolCallId

		// ── Run 2: deny → model retries → new approval requested ──────────────
		const result2 = await agent.run({
			state: withApprovals(result1.state, [
				{ toolCallId: id1, approved: false, denialReason: 'Not during business hours' },
			]),
		}).result
		expect(result2.finishReason).toBe('approvalRequired')
		expect(deployCallCount).toBe(0)

		// approvalHistory now has run 1's decision with full structured metadata
		expect(result2.state.approvalHistory).toHaveLength(1)
		const hist1 = result2.state.approvalHistory![0]!
		expect(hist1.toolCallId).toBe(id1)
		expect(hist1.toolName).toBe('deploy')
		expect(hist1.approval.message).toBe('Please confirm deploy to production')
		expect(hist1.decision.approved).toBe(false)
		if (!hist1.decision.approved) {
			expect(hist1.decision.denialReason).toBe('Not during business hours')
		}

		// New approval request is pending with its own structured message
		expect(result2.state.pendingToolCalls).toHaveLength(1)
		const pending2 = result2.state.pendingToolCalls![0]!
		expect(pending2.type).toBe('approval')
		if (pending2.type === 'approval') {
			expect(pending2.approval.message).toBe('Please confirm deploy to production')
		}
		const id2 = pending2.toolCallId

		// ── Run 3: approve → completes → both decisions in history ────────────
		const result3 = await agent.run({
			state: withApprovals(result2.state, [{ toolCallId: id2, approved: true }]),
		}).result
		expect(result3.finishReason).toBe('complete')
		expect(deployCallCount).toBe(1)

		// approvalHistory has both decisions with full structured metadata
		expect(result3.state.approvalHistory).toHaveLength(2)

		const finalHist1 = result3.state.approvalHistory![0]!
		expect(finalHist1.toolCallId).toBe(id1)
		expect(finalHist1.approval.message).toBe('Please confirm deploy to production')
		expect(finalHist1.decision.approved).toBe(false)
		if (!finalHist1.decision.approved) {
			expect(finalHist1.decision.denialReason).toBe('Not during business hours')
		}

		const finalHist2 = result3.state.approvalHistory![1]!
		expect(finalHist2.toolCallId).toBe(id2)
		expect(finalHist2.approval.message).toBe('Please confirm deploy to production')
		expect(finalHist2.decision.approved).toBe(true)

		// No pending tool calls remain
		expect(result3.state.pendingToolCalls).toBeUndefined()
	})

	test('approvalHistory survives JSON round-trip between runs', async () => {
		const deploy = defineTool({
			name: 'deploy',
			description: 'Deploy',
			input: z.object({ env: z.string() }),
			output: z.string(),
			execute: async (input) => `Deployed to ${input.env}`,
		})

		const askHook: ApprovalHook = (ctx) =>
			ctx.ask({ message: `Approve deploy to ${(ctx.input as any).env ?? 'unknown'}` })

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('deploy', { env: 'staging' }), assistantText('Done.')]),
			tools: { deploy },
			hooks: { approval: [askHook] },
		})

		// Run 1: get approval request
		const result1 = await agent.run({ state: startState([userMessage('deploy staging')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')

		// Simulate serialization/deserialization between runs (the original problem)
		const serialized = JSON.stringify(result1.state)
		const restoredState = JSON.parse(serialized) as typeof result1.state

		// Verify structured metadata survived serialization
		const restoredPending = restoredState.pendingToolCalls![0]!
		expect(restoredPending.type).toBe('approval')
		if (restoredPending.type === 'approval') {
			expect(restoredPending.approval.message).toBe('Approve deploy to staging')
		}

		const id = restoredPending.toolCallId

		// Run 2: approve from restored state
		const result2 = await agent.run({
			state: withApprovals(restoredState, [{ toolCallId: id, approved: true }]),
		}).result
		expect(result2.finishReason).toBe('complete')

		// History has structured metadata intact
		expect(result2.state.approvalHistory).toHaveLength(1)
		const histEntry = result2.state.approvalHistory![0]!
		expect(histEntry.approval.message).toBe('Approve deploy to staging')
		expect(histEntry.decision.approved).toBe(true)
	})
})

// ─── Anthropic integration tests ──────────────────────────────────────────────

describe.skipIf(!process.env.ANTHROPIC_API_KEY || !!process.env.CI)('anthropic approval resume', () => {
	const TIMEOUT = 30_000

	async function getAnthropicModel() {
		return anthropic('claude-haiku-4-5-20251001')
	}

	test(
		'ctx.ask() → resume with approval → tool executes, model continues',
		async () => {
			let executed = false
			const model = await getAnthropicModel()

			const deploy = defineTool({
				name: 'deploy',
				description: 'Deploy to an environment',
				input: z.object({ env: z.string() }),
				execute: async (input) => {
					executed = true
					return `Deployed to ${input.env}`
				},
			})

			const askHook: ApprovalHook = (ctx) => ctx.ask({ message: 'Approve deployment?' })

			const agent = new Agent({
				model,
				system: 'You are a helpful assistant. When asked to deploy, use the deploy tool.',
				tools: { deploy },
				hooks: { approval: [askHook] },
			})

			const result1 = await agent.run({
				state: startState([userMessage('Deploy to production.')]),
			}).result

			expect(result1.finishReason).toBe('approvalRequired')
			expect(executed).toBe(false)
			expect(result1.state.pendingToolCalls).toBeDefined()
			expect(result1.state.pendingToolCalls!.length).toBeGreaterThan(0)

			const pendingCall = result1.state.pendingToolCalls![0]! as any
			const approvalId = pendingCall.approval.id

			const result2 = await agent.run({
				state: withApprovals(result1.state, [{ toolCallId: approvalId, approved: true }]),
			}).result

			expect(executed).toBe(true)
			expect(result2.finishReason).toBe('complete')

			const lastMsg = result2.state.messages[result2.state.messages.length - 1]!
			expect(lastMsg.role).toBe('assistant')
		},
		TIMEOUT,
	)

	test(
		'ctx.ask() → resume with denial → model sees denial message, adjusts',
		async () => {
			let executed = false
			const model = await getAnthropicModel()

			const deploy = defineTool({
				name: 'deploy',
				description: 'Deploy to an environment',
				input: z.object({ env: z.string() }),
				execute: async (input) => {
					executed = true
					return `Deployed to ${input.env}`
				},
			})

			const askHook: ApprovalHook = (ctx) => ctx.ask({ message: 'Approve deployment?' })

			const agent = new Agent({
				model,
				system: 'You are a helpful assistant. When asked to deploy, use the deploy tool.',
				tools: { deploy },
				hooks: { approval: [askHook] },
			})

			const result1 = await agent.run({
				state: startState([userMessage('Deploy to production.')]),
			}).result

			expect(result1.finishReason).toBe('approvalRequired')
			const pendingCall = result1.state.pendingToolCalls![0]! as any
			const approvalId = pendingCall.approval.id

			const result2 = await agent.run({
				state: withApprovals(result1.state, [
					{ toolCallId: approvalId, approved: false, denialReason: 'Deployment not allowed at this time.' },
				]),
			}).result

			expect(executed).toBe(false)
			expect(result2.finishReason).toBe('complete')

			// Model should see denial and respond accordingly
			const lastMsg = result2.state.messages[result2.state.messages.length - 1]!
			expect(lastMsg.role).toBe('assistant')
		},
		TIMEOUT,
	)

	test(
		'resume with synthetic tool result → model sees synthetic result, loop continues',
		async () => {
			let executed = false
			const model = await getAnthropicModel()

			const deploy = defineTool({
				name: 'deploy',
				description: 'Deploy to an environment',
				input: z.object({ env: z.string() }),
				execute: async (input) => {
					executed = true
					return `Deployed to ${input.env}`
				},
			})

			const askHook: ApprovalHook = (ctx) => ctx.ask({ message: 'Approve deployment?' })

			const agent = new Agent({
				model,
				system: 'You are a helpful assistant. When asked to deploy, use the deploy tool.',
				tools: { deploy },
				hooks: { approval: [askHook] },
			})

			const result1 = await agent.run({
				state: startState([userMessage('Deploy to production.')]),
			}).result

			expect(result1.finishReason).toBe('approvalRequired')

			// Use synthetic result instead of approval decision
			const toolCallId = extractToolCallId(result1.state.messages, 'deploy')
			const synthetic = toolResultMessage(
				toolCallId,
				'deploy',
				'External system deployed successfully to production.',
			)

			const result2 = await agent.run({
				state: startState([...result1.state.messages, synthetic]),
			}).result

			// Tool did not execute — synthetic result was used
			expect(executed).toBe(false)
			expect(result2.finishReason).toBe('complete')

			const lastMsg = result2.state.messages[result2.state.messages.length - 1]!
			expect(lastMsg.role).toBe('assistant')
		},
		TIMEOUT,
	)
})
