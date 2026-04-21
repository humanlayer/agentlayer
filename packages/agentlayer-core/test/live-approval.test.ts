import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Agent, type AgentEvent, defineTool, startState } from '../src'
import type { ApprovalRequest } from '../src/hooks'
import { assistantText, assistantWithToolCall, getToolResults, mockModel, outputValue, userMessage } from './mocks'

const dangerousTool = defineTool({
	name: 'dangerous',
	description: 'A dangerous tool that requires approval',
	input: z.object({ target: z.string() }),
	execute: async (input) => `Executed on ${input.target}`,
})

function createApprovalAgent(
	responses: Parameters<typeof mockModel>[0],
	opts?: {
		onApprovalRequested?: (
			approval: ApprovalRequest,
			toolCallId: string,
			toolName: string,
			input: Record<string, unknown>,
		) => void | Promise<void>
	},
) {
	return new Agent({
		model: mockModel(responses),
		tools: { dangerous: dangerousTool },
		onApprovalRequested: opts?.onApprovalRequested,
		hooks: {
			approval: [
				(ctx) => {
					if (ctx.toolName === 'dangerous') {
						return ctx.ask({ message: `Approve ${ctx.toolName}?` })
					}
					return ctx.next()
				},
			],
		},
	})
}

describe('live approval resolution', () => {
	test('resolveApproval returns false when run is not active', async () => {
		const agent = createApprovalAgent([assistantWithToolCall('dangerous', { target: 'prod' })])

		const run = agent.run({ state: startState([userMessage('do it')]) })
		const result = await run.result
		expect(result.finishReason).toBe('approvalRequired')
		expect(run.running).toBe(false)

		// After run ends, resolveApproval returns false (cold path needed)
		const resolved = run.resolveApproval('any-id', 'approve')
		expect(resolved).toBe(false)
	})

	test('resolveApproval approves a tool call in-flight', async () => {
		// The model will be called twice: first call triggers approval, second returns text
		const agent = createApprovalAgent([
			assistantWithToolCall('dangerous', { target: 'staging' }),
			assistantText('All done.'),
		])

		const run = agent.run({ state: startState([userMessage('deploy')]) })

		// Listen for approvalRequested events and auto-approve them
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
			if (event.type === 'approvalRequested') {
				// Resolve immediately — the microtask yield in the loop will pick it up
				const resolved = run.resolveApproval(event.toolCallId, 'approve')
				expect(resolved).toBe(true)
			}
		}

		const result = await run.result
		// Should complete (not approvalRequired) because we approved in-flight
		expect(result.finishReason).toBe('complete')
		// The dangerous tool should have executed
		expect(getToolResults(result.state.messages, { toolName: 'dangerous' }).length).toBeGreaterThan(0)
	})

	test('resolveApproval denies a tool call in-flight', async () => {
		const agent = createApprovalAgent([
			assistantWithToolCall('dangerous', { target: 'prod' }),
			assistantText('Understood, denied.'),
		])

		const run = agent.run({ state: startState([userMessage('delete prod')]) })

		for await (const event of run) {
			if (event.type === 'approvalRequested') {
				run.resolveApproval(event.toolCallId, 'deny', 'Too risky')
			}
		}

		const result = await run.result
		expect(result.finishReason).toBe('complete')
		// Should have a denial message in the context
		const hasdenial = getToolResults(result.state.messages).some((r) => outputValue(r).includes('denied'))
		expect(hasdenial).toBe(true)
	})

	test('onApprovalRequested callback fires before iterator event', async () => {
		const callbackOrder: string[] = []

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('dangerous', { target: 'test' })]),
			tools: { dangerous: dangerousTool },
			onApprovalRequested: () => {
				callbackOrder.push('callback')
			},
			hooks: {
				approval: [
					(ctx) => {
						if (ctx.toolName === 'dangerous') {
							return ctx.ask({ message: 'Approve?' })
						}
						return ctx.next()
					},
				],
			},
		})

		const run = agent.run({ state: startState([userMessage('go')]) })
		for await (const event of run) {
			if (event.type === 'approvalRequested') {
				callbackOrder.push('event')
			}
		}

		expect(callbackOrder).toEqual(['callback', 'event'])
	})

	test('onApprovalRequested errors are swallowed', async () => {
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('dangerous', { target: 'test' })]),
			tools: { dangerous: dangerousTool },
			onApprovalRequested: () => {
				throw new Error('callback exploded')
			},
			hooks: {
				approval: [(ctx) => (ctx.toolName === 'dangerous' ? ctx.ask({ message: 'Approve?' }) : ctx.next())],
			},
		})

		const run = agent.run({ state: startState([userMessage('go')]) })
		const result = await run.result
		// Should still finish with approvalRequired, not error
		expect(result.finishReason).toBe('approvalRequired')
	})

	test('pendingResolvers are empty after run finishes', async () => {
		const agent = createApprovalAgent([assistantWithToolCall('dangerous', { target: 'prod' })])

		const run = agent.run({ state: startState([userMessage('do it')]) })
		await run.result
		expect(run.pendingResolvers.size).toBe(0)
	})

	test('AgentRun.resolveApproval delegates to activeChildren', async () => {
		// Test the recursive delegation on AgentRun directly (unit test)
		const { AgentRun } = await import('../src/agent-run')

		const parent = new AgentRun()
		const child = new AgentRun()

		// Setup: child has a pending resolver, parent has child in activeChildren
		let childDecision: any = null
		child.pendingResolvers.set('tc_child', (d) => {
			childDecision = d
		})
		parent.activeChildren.add(child)

		// Parent delegates to child
		const resolved = parent.resolveApproval('tc_child', 'approve')
		expect(resolved).toBe(true)
		expect(childDecision).toEqual({ toolCallId: 'tc_child', approved: true })
		expect(child.pendingResolvers.size).toBe(0)

		// Cleanup
		parent.activeChildren.delete(child)
	})
})
