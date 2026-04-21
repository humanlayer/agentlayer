/**
 * Unit tests for AgentState helpers: startState() and withApprovals()
 *
 * Validates:
 * - startState() creates { messages } with no pending or history
 * - withApprovals() with a single approval removes it from pendingToolCalls, adds to approvalHistory
 * - withApprovals() with denial injects a tool-result message and records in approvalHistory
 * - withApprovals() with partial decisions — 3 pending, decide on 1, other 2 stay
 * - withApprovals() leaves type: 'stopped' entries untouched
 * - AgentState survives JSON.stringify → JSON.parse round-trip
 */

import { describe, expect, test } from 'bun:test'
import type { ApprovalRequest, PendingToolCall } from '../src/hooks'
import type { AgentState, ApprovalDecision, ApprovalHistoryEntry } from '../src/state'
import { sanitizeStateForPersistence, startState, withApprovals } from '../src/state'
import { getToolResults, outputValue, userMessage } from './mocks'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeApprovalRequest(toolCallId: string, toolName: string): ApprovalRequest {
	return {
		id: toolCallId,
		toolCallId,
		toolName,
		input: { arg: 'value' },
		message: `Please approve ${toolName}`,
	}
}

function makeApprovalPending(toolCallId: string, toolName: string): PendingToolCall {
	return {
		type: 'approval',
		toolCallId,
		toolName,
		input: { arg: 'value' },
		approval: makeApprovalRequest(toolCallId, toolName),
	}
}

function makeStoppedPending(toolCallId: string, toolName: string): PendingToolCall {
	return {
		type: 'stopped',
		toolCallId,
		toolName,
		input: { arg: 'value' },
		reason: 'ctx.stop() was called',
	}
}

// ─── startState() ─────────────────────────────────────────────────────────────

describe('startState()', () => {
	test('creates state with only messages — no pendingToolCalls, no approvalHistory', () => {
		const msgs = [userMessage('hello')]
		const state = startState(msgs)

		expect(state.messages).toBe(msgs)
		expect(state.pendingToolCalls).toBeUndefined()
		expect(state.approvalHistory).toBeUndefined()
	})

	test('creates empty state with empty message array', () => {
		const state = startState([])
		expect(state.messages).toEqual([])
		expect(Object.keys(state)).toEqual(['messages'])
	})
})

// ─── withApprovals() — approval case ─────────────────────────────────────────

describe('withApprovals() — single approval', () => {
	test('approved: removes entry from pendingToolCalls, records in approvalHistory', () => {
		const pending = makeApprovalPending('call-1', 'deploy')
		const state: AgentState = {
			messages: [userMessage('deploy please')],
			pendingToolCalls: [pending],
		}

		const decision: ApprovalDecision = { toolCallId: 'call-1', approved: true }
		const next = withApprovals(state, [decision])

		// Entry removed from pendingToolCalls
		expect(next.pendingToolCalls).toBeUndefined()

		// Recorded in approvalHistory
		expect(next.approvalHistory).toHaveLength(1)
		const histEntry = next.approvalHistory![0]!
		expect(histEntry.toolCallId).toBe('call-1')
		expect(histEntry.toolName).toBe('deploy')
		expect(histEntry.decision).toEqual(decision)
		// pending is typed as PendingToolCall (discriminated union) — narrow to access .approval
		const pendingApproval = pending as Extract<PendingToolCall, { type: 'approval' }>
		expect(histEntry.approval).toEqual(pendingApproval.approval)

		// Messages unchanged (approval adds no tool-result message)
		expect(next.messages).toHaveLength(1)
	})
})

// ─── withApprovals() — denial case ───────────────────────────────────────────

describe('withApprovals() — denial', () => {
	test('denied: injects tool-result denial message, records in approvalHistory', () => {
		const pending = makeApprovalPending('call-2', 'rm')
		const state: AgentState = {
			messages: [userMessage('delete please')],
			pendingToolCalls: [pending],
		}

		const decision: ApprovalDecision = { toolCallId: 'call-2', approved: false, denialReason: 'Too risky' }
		const next = withApprovals(state, [decision])

		// Entry removed from pendingToolCalls
		expect(next.pendingToolCalls).toBeUndefined()

		// Denial tool-result message injected
		expect(next.messages).toHaveLength(2)
		const [denialPart] = getToolResults(next.messages)
		expect(denialPart).toBeDefined()
		expect(denialPart!.toolCallId).toBe('call-2')
		expect(outputValue(denialPart!)).toContain('Too risky')

		// Recorded in approvalHistory
		expect(next.approvalHistory).toHaveLength(1)
		expect(next.approvalHistory![0]!.decision).toEqual(decision)
	})

	test('denied without reason: uses generic denial message', () => {
		const pending = makeApprovalPending('call-3', 'deploy')
		const state: AgentState = {
			messages: [],
			pendingToolCalls: [pending],
		}

		const decision: ApprovalDecision = { toolCallId: 'call-3', approved: false }
		const next = withApprovals(state, [decision])

		expect(next.messages).toHaveLength(1)
		const [denialPart] = getToolResults(next.messages)
		expect(denialPart).toBeDefined()
		expect(outputValue(denialPart!)).toContain('denied this tool call')
	})
})

// ─── withApprovals() — partial decisions ─────────────────────────────────────

describe('withApprovals() — partial decisions', () => {
	test('3 pending, decide on 1 → other 2 remain in pendingToolCalls', () => {
		const p1 = makeApprovalPending('call-a', 'tool-a')
		const p2 = makeApprovalPending('call-b', 'tool-b')
		const p3 = makeApprovalPending('call-c', 'tool-c')

		const state: AgentState = {
			messages: [userMessage('run tools')],
			pendingToolCalls: [p1, p2, p3],
		}

		const decision: ApprovalDecision = { toolCallId: 'call-b', approved: true }
		const next = withApprovals(state, [decision])

		// call-a and call-c remain pending
		expect(next.pendingToolCalls).toHaveLength(2)
		const remainingIds = next.pendingToolCalls!.map((p) => p.toolCallId)
		expect(remainingIds).toContain('call-a')
		expect(remainingIds).toContain('call-c')
		expect(remainingIds).not.toContain('call-b')

		// Only call-b recorded in history
		expect(next.approvalHistory).toHaveLength(1)
		expect(next.approvalHistory![0]!.toolCallId).toBe('call-b')
	})

	test('no decisions provided → state is returned unchanged (all pending stay)', () => {
		const p1 = makeApprovalPending('call-x', 'tool-x')
		const state: AgentState = {
			messages: [userMessage('wait')],
			pendingToolCalls: [p1],
		}

		const next = withApprovals(state, [])
		expect(next.pendingToolCalls).toHaveLength(1)
		expect(next.approvalHistory).toBeUndefined()
	})
})

// ─── withApprovals() — stopped entries untouched ─────────────────────────────

describe('withApprovals() — stopped entries', () => {
	test('type: stopped entries are not touched by withApprovals', () => {
		const stopped = makeStoppedPending('call-s1', 'stopped-tool')
		const approval = makeApprovalPending('call-a1', 'approval-tool')

		const state: AgentState = {
			messages: [userMessage('run')],
			pendingToolCalls: [stopped, approval],
		}

		// Approve the approval-gated one
		const decision: ApprovalDecision = { toolCallId: 'call-a1', approved: true }
		const next = withApprovals(state, [decision])

		// stopped entry is still there
		expect(next.pendingToolCalls).toHaveLength(1)
		expect(next.pendingToolCalls![0]!.toolCallId).toBe('call-s1')
		expect(next.pendingToolCalls![0]!.type).toBe('stopped')

		// approval-gated entry was removed
		// history has the approved entry
		expect(next.approvalHistory).toHaveLength(1)
		expect(next.approvalHistory![0]!.toolCallId).toBe('call-a1')
	})

	test('all stopped entries — withApprovals is a no-op', () => {
		const stopped1 = makeStoppedPending('call-s2', 'tool-s2')
		const stopped2 = makeStoppedPending('call-s3', 'tool-s3')

		const state: AgentState = {
			messages: [],
			pendingToolCalls: [stopped1, stopped2],
		}

		const decision: ApprovalDecision = { toolCallId: 'call-s2', approved: true }
		const next = withApprovals(state, [decision])

		// No change — type: stopped entries not touched
		expect(next.pendingToolCalls).toHaveLength(2)
		expect(next.approvalHistory).toBeUndefined()
	})
})

// ─── approvalHistory accumulation ────────────────────────────────────────────

describe('withApprovals() — history accumulation', () => {
	test('new decisions are appended to existing approvalHistory', () => {
		const existingHistory: ApprovalHistoryEntry[] = [
			{
				toolCallId: 'old-call',
				toolName: 'old-tool',
				input: {},
				approval: makeApprovalRequest('old-call', 'old-tool'),
				decision: { toolCallId: 'old-call', approved: true },
			},
		]

		const pending = makeApprovalPending('new-call', 'new-tool')
		const state: AgentState = {
			messages: [],
			pendingToolCalls: [pending],
			approvalHistory: existingHistory,
		}

		const decision: ApprovalDecision = { toolCallId: 'new-call', approved: false }
		const next = withApprovals(state, [decision])

		expect(next.approvalHistory).toHaveLength(2)
		expect(next.approvalHistory![0]!.toolCallId).toBe('old-call')
		expect(next.approvalHistory![1]!.toolCallId).toBe('new-call')
	})
})

// ─── Immutability ─────────────────────────────────────────────────────────────

describe('withApprovals() — immutability', () => {
	test('returns a new object; does not mutate the input state', () => {
		const pending = makeApprovalPending('call-imm', 'deploy')
		const original: AgentState = {
			messages: [userMessage('go')],
			pendingToolCalls: [pending],
		}

		const decision: ApprovalDecision = { toolCallId: 'call-imm', approved: true }
		const next = withApprovals(original, [decision])

		expect(next).not.toBe(original)
		// Original is not mutated
		expect(original.pendingToolCalls).toHaveLength(1)
		expect(original.approvalHistory).toBeUndefined()
	})
})

// ─── Phase 3: approval history accumulation across 3+ runs ───────────────────

describe('approvalHistory accumulates across 3+ sequential withApprovals() calls', () => {
	test('each call appends to prior history', () => {
		// Run 1 state: three pending approval requests
		const p1 = makeApprovalPending('call-r1', 'tool-r1')
		const p2 = makeApprovalPending('call-r2', 'tool-r2')
		const p3 = makeApprovalPending('call-r3', 'tool-r3')

		const state0: AgentState = {
			messages: [userMessage('run three tools')],
			pendingToolCalls: [p1, p2, p3],
		}

		// Run 1 → 2: approve call-r1
		const state1 = withApprovals(state0, [{ toolCallId: 'call-r1', approved: true }])
		expect(state1.approvalHistory).toHaveLength(1)
		expect(state1.approvalHistory![0]!.toolCallId).toBe('call-r1')
		expect(state1.pendingToolCalls).toHaveLength(2)

		// Run 2 → 3: deny call-r2 with a reason
		const state2 = withApprovals(state1, [{ toolCallId: 'call-r2', approved: false, denialReason: 'Not safe' }])
		expect(state2.approvalHistory).toHaveLength(2)
		expect(state2.approvalHistory![0]!.toolCallId).toBe('call-r1')
		expect(state2.approvalHistory![1]!.toolCallId).toBe('call-r2')
		expect(state2.approvalHistory![1]!.decision).toEqual({
			toolCallId: 'call-r2',
			approved: false,
			denialReason: 'Not safe',
		})
		expect(state2.pendingToolCalls).toHaveLength(1)

		// Run 3 → 4: approve call-r3
		const state3 = withApprovals(state2, [{ toolCallId: 'call-r3', approved: true }])
		expect(state3.approvalHistory).toHaveLength(3)
		expect(state3.approvalHistory![0]!.toolCallId).toBe('call-r1')
		expect(state3.approvalHistory![1]!.toolCallId).toBe('call-r2')
		expect(state3.approvalHistory![2]!.toolCallId).toBe('call-r3')
		expect(state3.pendingToolCalls).toBeUndefined()
	})
})

// ─── Phase 3: structured ApprovalRequest metadata preserved in pendingToolCalls

describe('pendingToolCalls carries structured ApprovalRequest metadata', () => {
	test('approval.message field is preserved in pendingToolCalls', () => {
		const approvalRequest: ApprovalRequest = {
			id: 'call-meta-1',
			toolCallId: 'call-meta-1',
			toolName: 'deploy',
			input: { env: 'production' },
			message: 'Deploying to production is risky — please confirm.',
		}

		const pending: PendingToolCall = {
			type: 'approval',
			toolCallId: 'call-meta-1',
			toolName: 'deploy',
			input: { env: 'production' },
			approval: approvalRequest,
		}

		const state: AgentState = {
			messages: [userMessage('deploy please')],
			pendingToolCalls: [pending],
		}

		// The structured approval metadata (including message) is accessible
		const entry = state.pendingToolCalls![0]!
		expect(entry.type).toBe('approval')
		if (entry.type === 'approval') {
			expect(entry.approval.message).toBe('Deploying to production is risky — please confirm.')
			expect(entry.approval.toolName).toBe('deploy')
			expect(entry.approval.input).toEqual({ env: 'production' })
		}
	})

	test('approval metadata is preserved after JSON round-trip', () => {
		const approvalRequest: ApprovalRequest = {
			id: 'call-rt-2',
			toolCallId: 'call-rt-2',
			toolName: 'rm',
			input: { path: '/tmp/important' },
			message: 'This will permanently delete the file.',
		}

		const state: AgentState = {
			messages: [userMessage('delete file')],
			pendingToolCalls: [
				{
					type: 'approval',
					toolCallId: 'call-rt-2',
					toolName: 'rm',
					input: { path: '/tmp/important' },
					approval: approvalRequest,
				},
			],
		}

		const restored = JSON.parse(JSON.stringify(state)) as AgentState
		const entry = restored.pendingToolCalls![0]!
		expect(entry.type).toBe('approval')
		if (entry.type === 'approval') {
			expect(entry.approval.message).toBe('This will permanently delete the file.')
		}
	})

	test('approval metadata is preserved in approvalHistory after withApprovals()', () => {
		const approvalRequest: ApprovalRequest = {
			id: 'call-hist-1',
			toolCallId: 'call-hist-1',
			toolName: 'deploy',
			input: { env: 'staging' },
			message: 'Approve staging deploy?',
		}

		const state: AgentState = {
			messages: [userMessage('deploy staging')],
			pendingToolCalls: [
				{
					type: 'approval',
					toolCallId: 'call-hist-1',
					toolName: 'deploy',
					input: { env: 'staging' },
					approval: approvalRequest,
				},
			],
		}

		const next = withApprovals(state, [{ toolCallId: 'call-hist-1', approved: true }])

		// Structured metadata is preserved in approvalHistory
		expect(next.approvalHistory).toHaveLength(1)
		const histEntry = next.approvalHistory![0]!
		expect(histEntry.approval.message).toBe('Approve staging deploy?')
		expect(histEntry.approval.toolName).toBe('deploy')
		expect(histEntry.approval.input).toEqual({ env: 'staging' })
		expect(histEntry.decision).toEqual({ toolCallId: 'call-hist-1', approved: true })
	})
})

// ─── Phase 3: partial approval — approve 1, deny 1, leave 1 ──────────────────

describe('withApprovals() — 3 pending, approve 1, deny 1, leave 1', () => {
	test('each outcome lands in the correct bucket', () => {
		const pA = makeApprovalPending('call-A', 'tool-A')
		const pB = makeApprovalPending('call-B', 'tool-B')
		const pC = makeApprovalPending('call-C', 'tool-C')

		const state: AgentState = {
			messages: [userMessage('run tools A B C')],
			pendingToolCalls: [pA, pB, pC],
		}

		const next = withApprovals(state, [
			{ toolCallId: 'call-A', approved: true },
			{ toolCallId: 'call-B', approved: false, denialReason: 'B is not allowed' },
			// call-C intentionally omitted — left pending
		])

		// call-C remains in pendingToolCalls
		expect(next.pendingToolCalls).toHaveLength(1)
		expect(next.pendingToolCalls![0]!.toolCallId).toBe('call-C')

		// call-A and call-B recorded in approvalHistory
		expect(next.approvalHistory).toHaveLength(2)
		const histA = next.approvalHistory!.find((h) => h.toolCallId === 'call-A')!
		const histB = next.approvalHistory!.find((h) => h.toolCallId === 'call-B')!
		expect(histA.decision.approved).toBe(true)
		expect(histB.decision.approved).toBe(false)
		if (!histB.decision.approved) {
			expect(histB.decision.denialReason).toBe('B is not allowed')
		}

		// Denial for call-B injected a tool-result message; call-A (approved) did not
		// Original message + 1 denial message
		expect(next.messages).toHaveLength(2)
		const denialMsg = next.messages[1]!
		expect(denialMsg.role).toBe('tool')
		if (denialMsg.role === 'tool' && Array.isArray(denialMsg.content)) {
			const part = denialMsg.content[0]! as any
			expect(part.toolCallId).toBe('call-B')
			const outputText = typeof part.output === 'object' ? part.output.value : part.output
			expect(outputText).toContain('B is not allowed')
		}
	})
})

// ─── JSON round-trip ──────────────────────────────────────────────────────────

describe('AgentState JSON round-trip', () => {
	test('state with messages and pending survives stringify → parse', () => {
		const pending = makeApprovalPending('call-rt', 'deploy')
		const state: AgentState = {
			messages: [userMessage('round trip test')],
			pendingToolCalls: [pending],
			approvalHistory: [
				{
					toolCallId: 'prior-call',
					toolName: 'prior-tool',
					input: { key: 'val' },
					approval: makeApprovalRequest('prior-call', 'prior-tool'),
					decision: { toolCallId: 'prior-call', approved: true },
				},
			],
		}

		const serialized = JSON.stringify(state)
		const restored = JSON.parse(serialized) as AgentState

		expect(restored.messages).toHaveLength(1)
		expect(restored.pendingToolCalls).toHaveLength(1)
		expect(restored.pendingToolCalls![0]!.toolCallId).toBe('call-rt')
		expect(restored.pendingToolCalls![0]!.type).toBe('approval')
		expect(restored.approvalHistory).toHaveLength(1)
		expect(restored.approvalHistory![0]!.toolCallId).toBe('prior-call')
	})

	test('startState output survives round-trip', () => {
		const state = startState([userMessage('simple')])
		const restored = JSON.parse(JSON.stringify(state)) as AgentState
		expect(restored.messages).toHaveLength(1)
		expect(restored.pendingToolCalls).toBeUndefined()
		expect(restored.approvalHistory).toBeUndefined()
	})
})

// ─── sanitizeStateForPersistence() ────────────────────────────────────────────

describe('sanitizeStateForPersistence()', () => {
	test('strips itemId from message-level providerOptions.openai', () => {
		const state: AgentState = {
			messages: [
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'Hello' }],
					providerOptions: {
						openai: {
							itemId: 'msg_abc123',
							phase: 'final_answer',
							someOtherField: 'keep this',
						},
					},
				},
			],
		}

		const sanitized = sanitizeStateForPersistence(state)

		// itemId and phase should be stripped
		const assistantMsg = sanitized.messages[0]! as any
		expect(assistantMsg.providerOptions?.openai?.itemId).toBeUndefined()
		expect(assistantMsg.providerOptions?.openai?.phase).toBeUndefined()
		// Other fields should be preserved
		expect(assistantMsg.providerOptions?.openai?.someOtherField).toBe('keep this')
	})

	test('strips itemId from content-level providerOptions.openai', () => {
		const state: AgentState = {
			messages: [
				{
					role: 'assistant',
					content: [
						{
							type: 'text',
							text: 'Hello',
							providerOptions: {
								openai: {
									itemId: 'msg_content123',
									phase: 'streaming',
								},
							},
						},
					],
				},
			],
		}

		const sanitized = sanitizeStateForPersistence(state)

		const assistantMsg = sanitized.messages[0]! as any
		const textPart = assistantMsg.content[0]
		expect(textPart.providerOptions?.openai?.itemId).toBeUndefined()
		expect(textPart.providerOptions?.openai?.phase).toBeUndefined()
	})

	test('preserves non-OpenAI providerOptions', () => {
		const state: AgentState = {
			messages: [
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'Hello' }],
					providerOptions: {
						anthropic: {
							cacheControl: { type: 'ephemeral' },
						},
						openai: {
							itemId: 'strip_this',
						},
					},
				},
			],
		}

		const sanitized = sanitizeStateForPersistence(state)

		const assistantMsg = sanitized.messages[0]! as any
		// Anthropic options preserved
		expect(assistantMsg.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' })
		// OpenAI itemId stripped, but openai key may be removed if empty
		expect(assistantMsg.providerOptions?.openai?.itemId).toBeUndefined()
	})

	test('handles state without providerOptions', () => {
		const state: AgentState = {
			messages: [
				{
					role: 'user',
					content: [{ type: 'text', text: 'Hello' }],
				},
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'Hi there!' }],
				},
			],
		}

		const sanitized = sanitizeStateForPersistence(state)

		expect(sanitized.messages).toHaveLength(2)
		expect(sanitized.messages[0]).toEqual(state.messages[0])
		expect(sanitized.messages[1]).toEqual(state.messages[1])
	})

	test('recursively sanitizes sub-agent states', () => {
		const state: AgentState = {
			messages: [userMessage('parent message')],
			subAgents: {
				'child-1': {
					messages: [
						{
							role: 'assistant',
							content: [{ type: 'text', text: 'child response' }],
							providerOptions: {
								openai: {
									itemId: 'child_item_123',
								},
							},
						},
					],
				},
			},
		}

		const sanitized = sanitizeStateForPersistence(state)

		const childState = sanitized.subAgents?.['child-1']
		expect(childState).toBeDefined()
		const childMsg = childState!.messages[0] as any
		expect(childMsg.providerOptions?.openai?.itemId).toBeUndefined()
	})

	test('returns new state object (immutable)', () => {
		const state: AgentState = {
			messages: [
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'Hello' }],
					providerOptions: {
						openai: { itemId: 'test123' },
					},
				},
			],
		}

		const sanitized = sanitizeStateForPersistence(state)

		expect(sanitized).not.toBe(state)
		expect(sanitized.messages).not.toBe(state.messages)
		// Original should be unchanged
		expect((state.messages[0] as any).providerOptions?.openai?.itemId).toBe('test123')
	})
})
