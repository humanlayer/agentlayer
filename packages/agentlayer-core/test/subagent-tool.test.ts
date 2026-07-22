import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { Agent, type AgentEvent, defineTool, getAllPendingApprovals, startState, withApprovals } from '../src'
import { createSubagentsTool } from '../src/tools'
import { deriveChildPromptCacheKey } from '../src/tools/subagent'
import {
	assistantText,
	assistantWithToolCall,
	assistantWithToolCalls,
	getToolResults,
	mockModel,
	outputValue,
	userMessage,
} from './mocks'

// ── Helpers ──────────────────────────────────────────────────────────────────

describe('subagent prompt cache keys', () => {
	test('keeps UUID parents intact and derives stable distinct 28-character suffixes', async () => {
		const parent = '019f8ace-744b-7b97-8b4f-7e5b1ac44a87'
		const first = await deriveChildPromptCacheKey(parent, 'call-one')
		const replay = await deriveChildPromptCacheKey(parent, 'call-one')
		const second = await deriveChildPromptCacheKey(parent, 'call-two')

		expect(first).toBe(replay)
		expect(first).not.toBe(second)
		expect(first.startsWith(parent)).toBe(true)
		expect(first.slice(parent.length)).toBe('LVmC-KrzY82nW4KA9Qh5N0U0rjbx')
		expect(first).toHaveLength(64)
	})

	test('bounds child keys for generic long parent keys', async () => {
		for (const parent of ['', 'short', 'x'.repeat(36), 'x'.repeat(64), 'x'.repeat(200)]) {
			const key = await deriveChildPromptCacheKey(parent, 'call-one')
			expect(key.length).toBeLessThanOrEqual(64)
			expect(key).toMatch(/^[A-Za-z0-9_-]+$/)
		}
	})
})

/** Extract all tool-result output values from messages for a given tool name. */
function getToolResultValues(messages: ModelMessage[], toolName: string): string[] {
	return getToolResults(messages, { toolName }).map(outputValue)
}

/** Get the message roles in order, for verifying conversation structure. */
function messageRoles(messages: ModelMessage[]): string[] {
	return messages.map((m) => m.role)
}

// ── Tools ────────────────────────────────────────────────────────────────────

const echoTool = defineTool({
	name: 'echo',
	description: 'Echo input',
	input: z.object({ text: z.string() }),
	execute: async (input) => `Echo: ${input.text}`,
})

const approvedTool = defineTool({
	name: 'dangerous',
	description: 'Needs approval',
	input: z.object({ value: z.string() }),
	execute: async (input) => `Done: ${input.value}`,
})

function createLocalReadTool(cwd: string) {
	return defineTool({
		name: 'read',
		description: 'Read file from disk',
		input: z.object({ file_path: z.string(), limit: z.number().optional() }),
		execute: async (input) => {
			const filePath = join(cwd, input.file_path)
			return await readFile(filePath, 'utf8')
		},
	})
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('createSubagentsTool', () => {
	test('description includes all registered agent names', () => {
		const childAgent = new Agent({
			model: mockModel([assistantText('hi')]),
			tools: { echo: echoTool },
		})

		const tool = createSubagentsTool({
			agents: [
				{ name: 'researcher', description: 'Deep codebase research', agent: childAgent },
				{ name: 'implementer', description: 'Implement from a plan', agent: childAgent },
			],
		})

		expect(tool.description).toContain('researcher')
		expect(tool.description).toContain('Deep codebase research')
		expect(tool.description).toContain('implementer')
		expect(tool.description).toContain('Implement from a plan')
	})

	test('invalid subagent_type returns error in tool result', async () => {
		const childAgent = new Agent({
			model: mockModel([assistantText('hi')]),
			tools: { echo: echoTool },
		})

		const tool = createSubagentsTool({
			agents: [{ name: 'worker', description: 'A worker', agent: childAgent }],
		})

		const parentAgent = new Agent({
			model: mockModel([
				assistantWithToolCall('subagent', {
					description: 'test',
					prompt: 'do stuff',
					subagent_type: 'nonexistent',
				}),
				assistantText('ok'),
			]),
			tools: { subagent: tool },
		})

		const result = await parentAgent.run({ state: startState([userMessage('go')]) }).result
		expect(result.finishReason).toBe('complete')

		const subagentResults = getToolResultValues(result.state.messages, 'subagent')
		expect(subagentResults).toHaveLength(1)
		expect(subagentResults[0]).toContain('Unknown agent type')
		expect(subagentResults[0]).toContain('nonexistent')
		expect(subagentResults[0]).toContain('worker') // suggests available types
	})

	test('child runs to completion, parent gets child output in tool result', async () => {
		const childAgent = new Agent({
			model: mockModel([
				assistantWithToolCall('echo', { text: 'hello world' }),
				assistantText('Child finished.'),
			]),
			tools: { echo: echoTool },
		})

		const tool = createSubagentsTool({
			agents: [{ name: 'worker', description: 'A worker', agent: childAgent }],
		})

		const parentAgent = new Agent({
			model: mockModel([
				assistantWithToolCall('subagent', {
					description: 'test',
					prompt: 'do work',
					subagent_type: 'worker',
				}),
				assistantText('All done.'),
			]),
			tools: { subagent: tool },
		})

		const result = await parentAgent.run({ state: startState([userMessage('go')]) }).result
		expect(result.finishReason).toBe('complete')

		// The subagent tool result should contain the child's last assistant text
		const subagentResults = getToolResultValues(result.state.messages, 'subagent')
		expect(subagentResults).toHaveLength(1)
		expect(subagentResults[0]).toContain('<agent_result>')
		expect(subagentResults[0]).toContain('Child finished.')
		expect(subagentResults[0]).toContain('</agent_result>')

		// Message structure: user → assistant(tool_call:subagent) → tool(subagent result) → assistant(text)
		expect(messageRoles(result.state.messages)).toEqual(['user', 'assistant', 'tool', 'assistant'])

		// No subAgents or pendingToolCalls left in state
		expect(result.state.subAgents).toBeUndefined()
		expect(result.state.pendingToolCalls).toBeUndefined()
	})

	test('child can use tools configured with its own cwd', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'subagent-tool-test-'))
		try {
			await writeFile(join(dir, 'relative.txt'), 'hello from child cwd\n')

			const childAgent = new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: 'relative.txt', limit: 2000 }),
					assistantText('Child saw hello from child cwd.'),
				]),
				tools: { read: createLocalReadTool(dir) },
			})

			const tool = createSubagentsTool({
				agents: [{ name: 'worker', description: 'A worker', agent: childAgent }],
			})

			const parentAgent = new Agent({
				model: mockModel([
					assistantWithToolCall('subagent', {
						description: 'test',
						prompt: 'read the relative file',
						subagent_type: 'worker',
					}),
					assistantText('Parent done.'),
				]),
				tools: { subagent: tool },
			})

			const result = await parentAgent.run({ state: startState([userMessage('go')]) }).result
			expect(result.finishReason).toBe('complete')

			const subagentResults = getToolResultValues(result.state.messages, 'subagent')
			expect(subagentResults).toHaveLength(1)
			expect(subagentResults[0]).toContain('Child saw hello from child cwd.')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('child pauses for approval, parent exits approvalRequired with correct state tree', async () => {
		const childAgent = new Agent({
			model: mockModel([assistantWithToolCall('dangerous', { value: 'test' })]),
			tools: { dangerous: approvedTool },
			hooks: {
				approval: [(ctx) => (ctx.toolName === 'dangerous' ? ctx.ask({ message: 'Approve?' }) : ctx.next())],
			},
		})

		const tool = createSubagentsTool({
			agents: [{ name: 'worker', description: 'A worker', agent: childAgent }],
		})

		const parentAgent = new Agent({
			model: mockModel([
				assistantWithToolCall('subagent', {
					description: 'test',
					prompt: 'do dangerous thing',
					subagent_type: 'worker',
				}),
			]),
			tools: { subagent: tool },
		})

		const result = await parentAgent.run({ state: startState([userMessage('go')]) }).result
		expect(result.finishReason).toBe('approvalRequired')

		// Parent has a subAgent pending entry (not an approval — the approval is nested inside)
		expect(result.state.pendingToolCalls).toHaveLength(1)
		const pendingEntry = result.state.pendingToolCalls![0]!
		expect(pendingEntry.type).toBe('subAgent')
		expect(pendingEntry.toolName).toBe('subagent')
		if (pendingEntry.type === 'subAgent') {
			expect(pendingEntry.subAgentType).toBe('subagent')
		}

		// subAgents record contains the child's state
		expect(result.state.subAgents).toBeDefined()
		const childAgentIds = Object.keys(result.state.subAgents!)
		expect(childAgentIds).toHaveLength(1)

		const childState = result.state.subAgents![childAgentIds[0]!]!
		// Child state has its own pendingToolCalls with the actual approval
		expect(childState.pendingToolCalls).toHaveLength(1)
		expect(childState.pendingToolCalls![0]!.type).toBe('approval')

		// No tool result message appended for the paused subagent call
		const subagentResults = getToolResultValues(result.state.messages, 'subagent')
		expect(subagentResults).toHaveLength(0)

		// getAllPendingApprovals traverses the tree and finds the nested approval
		const allPending = getAllPendingApprovals(result.state)
		expect(allPending).toHaveLength(1)
		expect(allPending[0]!.pending.type).toBe('approval')
		expect(allPending[0]!.path).toHaveLength(1) // one level deep
		expect(allPending[0]!.path[0]).toBe(childAgentIds[0]) // path points to child
	})

	test('approval + re-run resumes child, preserves all messages, and completes', async () => {
		const childCacheKeys: string[] = []
		const childAgent = new Agent({
			model: mockModel([
				assistantWithToolCall('dangerous', { value: 'test' }),
				assistantText('Child done after approval.'),
			]),
			tools: { dangerous: approvedTool },
			hooks: {
				approval: [(ctx) => (ctx.toolName === 'dangerous' ? ctx.ask({ message: 'Approve?' }) : ctx.next())],
			},
			providerOptions: ({ promptCacheKey }) => {
				childCacheKeys.push(promptCacheKey ?? '')
				return {}
			},
		})

		const tool = createSubagentsTool({
			agents: [{ name: 'worker', description: 'A worker', agent: childAgent }],
		})

		const parentAgent = new Agent({
			model: mockModel([
				assistantWithToolCall('subagent', {
					description: 'test',
					prompt: 'do dangerous thing',
					subagent_type: 'worker',
				}),
				assistantText('Parent done.'),
			]),
			tools: { subagent: tool },
		})

		// First run — child pauses
		const result1 = await parentAgent.run({ state: startState([userMessage('go')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')

		// Capture state before approval for comparison
		const messageCountBeforeApproval = result1.state.messages.length

		// Approve the child's approval
		const allPending = getAllPendingApprovals(result1.state)
		expect(allPending).toHaveLength(1)
		const approvedState = withApprovals(result1.state, [
			{ toolCallId: allPending[0]!.pending.toolCallId, approved: true },
		])

		// The approval should have been consumed in the child state
		const childId = Object.keys(approvedState.subAgents!)[0]!
		const childStateAfterApproval = approvedState.subAgents![childId]!
		expect(getAllPendingApprovals(childStateAfterApproval)).toHaveLength(0)
		// Child should have an approvalHistory entry
		expect(childStateAfterApproval.approvalHistory).toHaveLength(1)
		expect(childStateAfterApproval.approvalHistory![0]!.decision.approved).toBe(true)

		// Parent messages should be unchanged (withApprovals doesn't modify parent messages for nested approvals)
		expect(approvedState.messages).toHaveLength(messageCountBeforeApproval)

		// Second run — child resumes and completes
		const result2 = await parentAgent.run({ state: approvedState }).result
		expect(result2.finishReason).toBe('complete')
		expect(childCacheKeys).toHaveLength(2)
		expect(childCacheKeys[0]).toHaveLength(64)
		expect(childCacheKeys[1]).toBe(childCacheKeys[0])

		// The subagent tool result should contain the child's post-approval output
		const subagentResults = getToolResultValues(result2.state.messages, 'subagent')
		expect(subagentResults).toHaveLength(1)
		expect(subagentResults[0]).toContain('Child done after approval.')

		// Message structure after full completion
		expect(messageRoles(result2.state.messages)).toEqual(['user', 'assistant', 'tool', 'assistant'])

		// State is clean — no pending, no subAgents
		expect(result2.state.pendingToolCalls).toBeUndefined()
		expect(result2.state.subAgents).toBeUndefined()
	})

	test('child events forwarded to parent stream with agentId and parentToolCallId', async () => {
		const childAgent = new Agent({
			model: mockModel([assistantText('Hello from child agent!')]),
			tools: {},
		})

		const tool = createSubagentsTool({
			agents: [{ name: 'worker', description: 'A worker', agent: childAgent }],
		})

		const parentAgent = new Agent({
			model: mockModel([
				assistantWithToolCall('subagent', {
					description: 'test',
					prompt: 'say hi',
					subagent_type: 'worker',
				}),
				assistantText('Parent done.'),
			]),
			tools: { subagent: tool },
		})

		const run = parentAgent.run({ state: startState([userMessage('go')]) })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const result = await run.result
		expect(result.finishReason).toBe('complete')

		// Root events have no agentId
		const rootEvents = events.filter((e) => e.agentId === undefined)
		expect(rootEvents.length).toBeGreaterThan(0)

		// Child events have agentId and parentToolCallId set
		const childEvents = events.filter((e) => e.agentId !== undefined)
		expect(childEvents.length).toBeGreaterThan(0)

		// All child events should have a parentToolCallId (the subagent tool call in the parent)
		for (const event of childEvents) {
			expect(event.parentToolCallId).toBeDefined()
		}

		// All child events share the same agentId
		const childAgentIds = new Set(childEvents.map((e) => e.agentId))
		expect(childAgentIds.size).toBe(1)
	})

	test('parallel subagent calls: one completes, one pauses — correct partial state', async () => {
		// Child A: completes immediately
		const childA = new Agent({
			model: mockModel([assistantText('Result from A.')]),
			tools: {},
		})

		// Child B: hits approval gate
		const childB = new Agent({
			model: mockModel([
				assistantWithToolCall('dangerous', { value: 'from-b' }),
				assistantText('B done after approval.'),
			]),
			tools: { dangerous: approvedTool },
			hooks: {
				approval: [(ctx) => (ctx.toolName === 'dangerous' ? ctx.ask({ message: 'Approve B?' }) : ctx.next())],
			},
		})

		const tool = createSubagentsTool({
			agents: [
				{ name: 'fast-worker', description: 'Completes fast', agent: childA },
				{ name: 'slow-worker', description: 'Needs approval', agent: childB },
			],
		})

		const parentAgent = new Agent({
			model: mockModel([
				// Parent dispatches two subagent calls in parallel
				assistantWithToolCalls(
					{ toolName: 'subagent', input: { description: 'a', prompt: 'do A', subagent_type: 'fast-worker' } },
					{ toolName: 'subagent', input: { description: 'b', prompt: 'do B', subagent_type: 'slow-worker' } },
				),
				assistantText('Parent done after resume.'),
			]),
			tools: { subagent: tool },
		})

		const result1 = await parentAgent.run({ state: startState([userMessage('go')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')

		// Child A completed — its tool result should be in the messages
		const subagentResults = getToolResultValues(result1.state.messages, 'subagent')
		expect(subagentResults).toHaveLength(1) // only A's result — B is paused
		expect(subagentResults[0]).toContain('Result from A.')

		// Child B paused — should be in pendingToolCalls and subAgents
		expect(result1.state.pendingToolCalls).toHaveLength(1)
		expect(result1.state.pendingToolCalls![0]!.type).toBe('subAgent')

		const childAgentIds = Object.keys(result1.state.subAgents ?? {})
		expect(childAgentIds).toHaveLength(1)

		// Approve B's child approval and resume
		const allPending = getAllPendingApprovals(result1.state)
		expect(allPending).toHaveLength(1)

		const approvedState = withApprovals(result1.state, [
			{ toolCallId: allPending[0]!.pending.toolCallId, approved: true },
		])

		const result2 = await parentAgent.run({ state: approvedState }).result
		expect(result2.finishReason).toBe('complete')

		// Now both tool results should be present
		const allSubagentResults = getToolResultValues(result2.state.messages, 'subagent')
		expect(allSubagentResults).toHaveLength(2)
		// A's result was preserved from before
		expect(allSubagentResults.some((r) => r.includes('Result from A.'))).toBe(true)
		// B's result was added after approval
		expect(allSubagentResults.some((r) => r.includes('B done after approval.'))).toBe(true)

		// State is clean
		expect(result2.state.pendingToolCalls).toBeUndefined()
		expect(result2.state.subAgents).toBeUndefined()
	})

	test('grandchild approval: parent → child → grandchild approval chain', async () => {
		// Grandchild: hits approval
		const grandchildAgent = new Agent({
			model: mockModel([
				assistantWithToolCall('dangerous', { value: 'deep' }),
				assistantText('Grandchild done.'),
			]),
			tools: { dangerous: approvedTool },
			hooks: {
				approval: [
					(ctx) => (ctx.toolName === 'dangerous' ? ctx.ask({ message: 'Deep approve?' }) : ctx.next()),
				],
			},
		})

		// Child: launches grandchild as its own subagent
		const grandchildTool = createSubagentsTool({
			agents: [{ name: 'grandchild-worker', description: 'A grandchild', agent: grandchildAgent }],
		})

		const childAgent = new Agent({
			model: mockModel([
				assistantWithToolCall('subagent', {
					description: 'nest',
					prompt: 'do deep work',
					subagent_type: 'grandchild-worker',
				}),
				assistantText('Child done with grandchild result.'),
			]),
			tools: { subagent: grandchildTool },
		})

		// Parent: launches child
		const childTool = createSubagentsTool({
			agents: [{ name: 'child-worker', description: 'A child', agent: childAgent }],
		})

		const parentAgent = new Agent({
			model: mockModel([
				assistantWithToolCall('subagent', {
					description: 'test',
					prompt: 'do nested work',
					subagent_type: 'child-worker',
				}),
				assistantText('Parent done.'),
			]),
			tools: { subagent: childTool },
		})

		// First run — grandchild pauses, bubbles up through child to parent
		const result1 = await parentAgent.run({ state: startState([userMessage('go')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')

		// getAllPendingApprovals should find the grandchild's approval
		const allPending = getAllPendingApprovals(result1.state)
		expect(allPending).toHaveLength(1)
		expect(allPending[0]!.path.length).toBe(2) // parent → child → grandchild (path has 2 segments)
		expect(allPending[0]!.pending.type).toBe('approval')

		// Verify state tree depth:
		// parent.subAgents has 1 child
		expect(Object.keys(result1.state.subAgents!)).toHaveLength(1)
		const childId = Object.keys(result1.state.subAgents!)[0]!
		const childState = result1.state.subAgents![childId]!
		// child.subAgents has 1 grandchild
		expect(Object.keys(childState.subAgents!)).toHaveLength(1)
		const grandchildId = Object.keys(childState.subAgents!)[0]!
		const grandchildState = childState.subAgents![grandchildId]!
		// grandchild has the actual approval pending
		expect(grandchildState.pendingToolCalls).toHaveLength(1)
		expect(grandchildState.pendingToolCalls![0]!.type).toBe('approval')

		// Approve the grandchild's approval via withApprovals (recursive)
		const approvedState = withApprovals(result1.state, [
			{ toolCallId: allPending[0]!.pending.toolCallId, approved: true },
		])

		// Verify the approval was consumed at the grandchild level
		const gcStateAfter = approvedState.subAgents![childId]!.subAgents![grandchildId]!
		expect(getAllPendingApprovals(gcStateAfter)).toHaveLength(0)
		expect(gcStateAfter.approvalHistory).toHaveLength(1)

		// Second run — grandchild resumes, child resumes, parent completes
		const result2 = await parentAgent.run({ state: approvedState }).result
		expect(result2.finishReason).toBe('complete')

		// Parent's tool result should contain the child's output (which summarizes grandchild)
		const subagentResults = getToolResultValues(result2.state.messages, 'subagent')
		expect(subagentResults).toHaveLength(1)
		expect(subagentResults[0]).toContain('Child done with grandchild result.')

		// All state cleaned up
		expect(result2.state.pendingToolCalls).toBeUndefined()
		expect(result2.state.subAgents).toBeUndefined()
	})

	test('denial flows through to child and parent continues', async () => {
		const childAgent = new Agent({
			model: mockModel([
				assistantWithToolCall('dangerous', { value: 'bad' }),
				assistantText('Child handled denial.'),
			]),
			tools: { dangerous: approvedTool },
			hooks: {
				approval: [(ctx) => (ctx.toolName === 'dangerous' ? ctx.ask({ message: 'Approve?' }) : ctx.next())],
			},
		})

		const tool = createSubagentsTool({
			agents: [{ name: 'worker', description: 'A worker', agent: childAgent }],
		})

		const parentAgent = new Agent({
			model: mockModel([
				assistantWithToolCall('subagent', {
					description: 'test',
					prompt: 'do thing',
					subagent_type: 'worker',
				}),
				assistantText('Parent after denial.'),
			]),
			tools: { subagent: tool },
		})

		// First run — child pauses for approval
		const result1 = await parentAgent.run({ state: startState([userMessage('go')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')

		// Deny the approval
		const allPending = getAllPendingApprovals(result1.state)
		const deniedState = withApprovals(result1.state, [
			{ toolCallId: allPending[0]!.pending.toolCallId, approved: false, denialReason: 'Not safe' },
		])

		// Second run — child resumes with denial, parent continues
		const result2 = await parentAgent.run({ state: deniedState }).result
		expect(result2.finishReason).toBe('complete')

		// The subagent tool result should contain the child's post-denial response
		const subagentResults = getToolResultValues(result2.state.messages, 'subagent')
		expect(subagentResults).toHaveLength(1)
		expect(subagentResults[0]).toContain('Child handled denial.')
	})

	test('parallel subagent calls: both pause, approve one at a time', async () => {
		// Both children need approval
		const childA = new Agent({
			model: mockModel([assistantWithToolCall('dangerous', { value: 'a-val' }), assistantText('A completed.')]),
			tools: { dangerous: approvedTool },
			hooks: {
				approval: [(ctx) => (ctx.toolName === 'dangerous' ? ctx.ask({ message: 'Approve A?' }) : ctx.next())],
			},
		})

		const childB = new Agent({
			model: mockModel([assistantWithToolCall('dangerous', { value: 'b-val' }), assistantText('B completed.')]),
			tools: { dangerous: approvedTool },
			hooks: {
				approval: [(ctx) => (ctx.toolName === 'dangerous' ? ctx.ask({ message: 'Approve B?' }) : ctx.next())],
			},
		})

		const tool = createSubagentsTool({
			agents: [
				{ name: 'worker-a', description: 'Worker A', agent: childA },
				{ name: 'worker-b', description: 'Worker B', agent: childB },
			],
		})

		const parentAgent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'subagent', input: { description: 'a', prompt: 'do A', subagent_type: 'worker-a' } },
					{ toolName: 'subagent', input: { description: 'b', prompt: 'do B', subagent_type: 'worker-b' } },
				),
				assistantText('All parallel done.'),
			]),
			tools: { subagent: tool },
		})

		// Run 1: both children pause
		const result1 = await parentAgent.run({ state: startState([userMessage('go')]) }).result
		expect(result1.finishReason).toBe('approvalRequired')
		expect(result1.state.pendingToolCalls).toHaveLength(2)
		expect(result1.state.pendingToolCalls!.every((p) => p.type === 'subAgent')).toBe(true)
		expect(Object.keys(result1.state.subAgents!)).toHaveLength(2)

		const allPending1 = getAllPendingApprovals(result1.state)
		expect(allPending1).toHaveLength(2)

		// No subagent tool results yet (both paused)
		expect(getToolResultValues(result1.state.messages, 'subagent')).toHaveLength(0)

		// Approve only the first one
		const stateAfterFirstApproval = withApprovals(result1.state, [
			{ toolCallId: allPending1[0]!.pending.toolCallId, approved: true },
		])

		// Run 2: first child completes, second still paused
		const result2 = await parentAgent.run({ state: stateAfterFirstApproval }).result
		expect(result2.finishReason).toBe('approvalRequired')

		// One subagent completed (tool result added), one still pending
		const subagentResultsAfterFirst = getToolResultValues(result2.state.messages, 'subagent')
		expect(subagentResultsAfterFirst).toHaveLength(1)

		expect(result2.state.pendingToolCalls).toHaveLength(1)
		expect(Object.keys(result2.state.subAgents!)).toHaveLength(1)

		// Approve the second
		const allPending2 = getAllPendingApprovals(result2.state)
		expect(allPending2).toHaveLength(1)
		const stateAfterSecondApproval = withApprovals(result2.state, [
			{ toolCallId: allPending2[0]!.pending.toolCallId, approved: true },
		])

		// Run 3: second child completes, parent finishes
		const result3 = await parentAgent.run({ state: stateAfterSecondApproval }).result
		expect(result3.finishReason).toBe('complete')

		const allSubagentResults = getToolResultValues(result3.state.messages, 'subagent')
		expect(allSubagentResults).toHaveLength(2)

		// State is clean
		expect(result3.state.pendingToolCalls).toBeUndefined()
		expect(result3.state.subAgents).toBeUndefined()
	})
})
