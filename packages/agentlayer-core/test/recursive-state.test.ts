/**
 * Phase 3: Recursive State Model + Pure Helpers
 *
 * Tests for:
 * - getAllPendingApprovals: flat state, nested 2-deep, nested 3-deep
 * - getAgentState: valid path, invalid path, empty path (returns root)
 * - withApprovals recursive: approve at root, approve at child, approve at grandchild, partial approval across levels
 * - subAgents field preserved when no decisions affect it
 * - PendingToolCall subAgent variant (type: 'subAgent')
 */

import { describe, expect, test } from 'bun:test'
import type { PendingToolCall } from '../src/hooks'
import type { AgentPath, AgentState } from '../src/state'
import { getAgentState, getAllPendingApprovals, startState, withApprovals } from '../src/state'
import { userMessage } from './mocks'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeApprovalPending(toolCallId: string, toolName: string): PendingToolCall {
	return {
		type: 'approval',
		toolCallId,
		toolName,
		input: { arg: 'value' },
		approval: {
			id: toolCallId,
			toolCallId,
			toolName,
			input: { arg: 'value' },
			message: `Please approve ${toolName}`,
		},
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

function makeSubAgentPending(
	toolCallId: string,
	toolName: string,
	agentId: string,
	subAgentType: string,
): PendingToolCall {
	return {
		type: 'subAgent',
		toolCallId,
		toolName,
		input: { task_id: agentId },
		agentId,
		subAgentType,
	}
}

function makeState(options: {
	msgs?: AgentState['messages']
	pending?: PendingToolCall[]
	subAgents?: Record<string, AgentState>
}): AgentState {
	return {
		messages: options.msgs ?? [userMessage('do stuff')],
		...(options.pending ? { pendingToolCalls: options.pending } : {}),
		...(options.subAgents ? { subAgents: options.subAgents } : {}),
	}
}

// ─── getAgentState ────────────────────────────────────────────────────────────

describe('getAgentState()', () => {
	test('empty path returns root state', () => {
		const root = makeState({})
		expect(getAgentState(root, [])).toBe(root)
	})

	test('single-element path returns matching sub-agent', () => {
		const child = makeState({ msgs: [userMessage('child work')] })
		const root = makeState({ subAgents: { 'child-1': child } })
		expect(getAgentState(root, ['child-1'])).toBe(child)
	})

	test('two-element path returns grandchild', () => {
		const grandchild = makeState({ msgs: [userMessage('grandchild work')] })
		const child = makeState({ subAgents: { 'grandchild-a': grandchild } })
		const root = makeState({ subAgents: { 'child-1': child } })
		expect(getAgentState(root, ['child-1', 'grandchild-a'])).toBe(grandchild)
	})

	test('invalid path returns undefined — missing first segment', () => {
		const root = makeState({})
		expect(getAgentState(root, ['nonexistent'])).toBeUndefined()
	})

	test('invalid path returns undefined — valid first segment, missing second', () => {
		const child = makeState({})
		const root = makeState({ subAgents: { 'child-1': child } })
		expect(getAgentState(root, ['child-1', 'nonexistent'])).toBeUndefined()
	})

	test('path into state with no subAgents returns undefined', () => {
		const root = makeState({ msgs: [userMessage('no children')] })
		expect(getAgentState(root, ['child-1'])).toBeUndefined()
	})
})

// ─── getAllPendingApprovals — flat state ───────────────────────────────────────

describe('getAllPendingApprovals() — flat state', () => {
	test('returns empty array for state with no pending', () => {
		const state = startState([userMessage('hello')])
		expect(getAllPendingApprovals(state)).toEqual([])
	})

	test('returns empty array for state with only stopped entries', () => {
		const state = makeState({
			pending: [makeStoppedPending('s1', 'tool-s1')],
		})
		expect(getAllPendingApprovals(state)).toEqual([])
	})

	test('returns empty array for state with only subAgent entries', () => {
		const state = makeState({
			pending: [makeSubAgentPending('sa1', 'subagent', 'agent-id-1', 'worker')],
		})
		expect(getAllPendingApprovals(state)).toEqual([])
	})

	test('returns approval entries at root with empty path', () => {
		const p1 = makeApprovalPending('call-1', 'deploy')
		const p2 = makeApprovalPending('call-2', 'rm')
		const state = makeState({ pending: [p1, p2] })

		const result = getAllPendingApprovals(state)
		expect(result).toHaveLength(2)
		expect(result[0]).toEqual({ path: [], pending: p1 })
		expect(result[1]).toEqual({ path: [], pending: p2 })
	})

	test('mixed pending: only approval entries are collected', () => {
		const approval = makeApprovalPending('call-a', 'tool-a')
		const stopped = makeStoppedPending('call-s', 'tool-s')
		const subAgent = makeSubAgentPending('call-sa', 'subagent', 'agent-1', 'worker')
		const state = makeState({ pending: [approval, stopped, subAgent] })

		const result = getAllPendingApprovals(state)
		expect(result).toHaveLength(1)
		expect(result[0]).toEqual({ path: [], pending: approval })
	})
})

// ─── getAllPendingApprovals — nested 2-deep ───────────────────────────────────

describe('getAllPendingApprovals() — nested 2-deep', () => {
	test('root + child approvals collected with correct paths', () => {
		const rootApproval = makeApprovalPending('root-call-1', 'root-tool')
		const childApproval = makeApprovalPending('child-call-1', 'child-tool')

		const child = makeState({ pending: [childApproval] })
		const root = makeState({
			pending: [rootApproval],
			subAgents: { 'child-1': child },
		})

		const result = getAllPendingApprovals(root)
		expect(result).toHaveLength(2)
		// Root entry comes first (depth-first, root before children)
		expect(result[0]).toEqual({ path: [], pending: rootApproval })
		expect(result[1]).toEqual({ path: ['child-1'], pending: childApproval })
	})

	test('no root approvals, only child approval', () => {
		const childApproval = makeApprovalPending('child-call-1', 'child-tool')
		const child = makeState({ pending: [childApproval] })
		const root = makeState({ subAgents: { worker: child } })

		const result = getAllPendingApprovals(root)
		expect(result).toHaveLength(1)
		expect(result[0]).toEqual({ path: ['worker'], pending: childApproval })
	})

	test('multiple sub-agents with approvals', () => {
		const approval1 = makeApprovalPending('call-w1', 'tool-1')
		const approval2 = makeApprovalPending('call-w2', 'tool-2')

		const worker1 = makeState({ pending: [approval1] })
		const worker2 = makeState({ pending: [approval2] })
		const root = makeState({
			subAgents: { 'worker-1': worker1, 'worker-2': worker2 },
		})

		const result = getAllPendingApprovals(root)
		expect(result).toHaveLength(2)
		// Both sub-agents' approvals present (order follows Object.entries)
		const ids = result.map((r) => r.pending.toolCallId)
		expect(ids).toContain('call-w1')
		expect(ids).toContain('call-w2')
	})
})

// ─── getAllPendingApprovals — nested 3-deep ───────────────────────────────────

describe('getAllPendingApprovals() — nested 3-deep', () => {
	test('collects approvals across 3 levels with correct paths', () => {
		const rootApproval = makeApprovalPending('root-call', 'root-tool')
		const childApproval = makeApprovalPending('child-call', 'child-tool')
		const grandchildApproval = makeApprovalPending('grand-call', 'grand-tool')

		const grandchild = makeState({ pending: [grandchildApproval] })
		const child = makeState({
			pending: [childApproval],
			subAgents: { 'grandchild-a': grandchild },
		})
		const root = makeState({
			pending: [rootApproval],
			subAgents: { 'child-1': child },
		})

		const result = getAllPendingApprovals(root)
		expect(result).toHaveLength(3)
		expect(result[0]).toEqual({ path: [], pending: rootApproval })
		expect(result[1]).toEqual({ path: ['child-1'], pending: childApproval })
		expect(result[2]).toEqual({ path: ['child-1', 'grandchild-a'], pending: grandchildApproval })
	})

	test('3-deep with only grandchild approval', () => {
		const grandchildApproval = makeApprovalPending('grand-call', 'grand-tool')
		const grandchild = makeState({ pending: [grandchildApproval] })
		const child = makeState({ subAgents: { gc: grandchild } })
		const root = makeState({ subAgents: { child: child } })

		const result = getAllPendingApprovals(root)
		expect(result).toHaveLength(1)
		expect(result[0]).toEqual({ path: ['child', 'gc'], pending: grandchildApproval })
	})
})

// ─── withApprovals — approve at root ─────────────────────────────────────────

describe('withApprovals() — approve at root (subAgents preserved)', () => {
	test('root approval resolved; subAgents field is preserved unchanged', () => {
		const rootApproval = makeApprovalPending('root-call', 'root-tool')
		const childApproval = makeApprovalPending('child-call', 'child-tool')
		const child = makeState({ pending: [childApproval] })
		const root = makeState({
			pending: [rootApproval],
			subAgents: { 'child-1': child },
		})

		const next = withApprovals(root, [{ toolCallId: 'root-call', approved: true }])

		// Root approval resolved
		expect(next.pendingToolCalls).toBeUndefined()
		// subAgents preserved with child's approval still pending
		expect(next.subAgents).toBeDefined()
		expect(next.subAgents!['child-1']?.pendingToolCalls).toHaveLength(1)
		expect(next.subAgents!['child-1']?.pendingToolCalls![0]!.toolCallId).toBe('child-call')
	})

	test('subAgents field absent when state has no subAgents', () => {
		const approval = makeApprovalPending('call-1', 'tool-1')
		const state = makeState({ pending: [approval] })

		const next = withApprovals(state, [{ toolCallId: 'call-1', approved: true }])

		expect(next.subAgents).toBeUndefined()
		expect(next.pendingToolCalls).toBeUndefined()
	})
})

// ─── withApprovals — approve at child ────────────────────────────────────────

describe('withApprovals() — approve at child', () => {
	test('child approval resolved; root remains pending', () => {
		const rootApproval = makeApprovalPending('root-call', 'root-tool')
		const childApproval = makeApprovalPending('child-call', 'child-tool')
		const child = makeState({ pending: [childApproval] })
		const root = makeState({
			pending: [rootApproval],
			subAgents: { 'child-1': child },
		})

		const next = withApprovals(root, [{ toolCallId: 'child-call', approved: true }])

		// Root approval still pending (not matched at root level)
		expect(next.pendingToolCalls).toHaveLength(1)
		expect(next.pendingToolCalls![0]!.toolCallId).toBe('root-call')

		// Child approval resolved (passed down as remaining decision)
		const updatedChild = next.subAgents!['child-1']!
		expect(updatedChild.pendingToolCalls).toBeUndefined()
		// Child approval recorded in child's approvalHistory
		expect(updatedChild.approvalHistory).toHaveLength(1)
		expect(updatedChild.approvalHistory![0]!.toolCallId).toBe('child-call')
	})

	test('child denial injects message into child state messages', () => {
		const childApproval = makeApprovalPending('child-call', 'child-tool')
		const child = makeState({ pending: [childApproval] })
		const root = makeState({ subAgents: { worker: child } })

		const next = withApprovals(root, [{ toolCallId: 'child-call', approved: false, denialReason: 'Not allowed' }])

		const updatedChild = next.subAgents!.worker!
		expect(updatedChild.pendingToolCalls).toBeUndefined()
		// Denial message injected into child's messages
		expect(updatedChild.messages.length).toBeGreaterThan(child.messages.length)
		const lastMsg = updatedChild.messages[updatedChild.messages.length - 1]!
		expect(lastMsg.role).toBe('tool')
	})
})

// ─── withApprovals — approve at grandchild ───────────────────────────────────

describe('withApprovals() — approve at grandchild', () => {
	test('grandchild approval resolved; root and child pending preserved', () => {
		const rootApproval = makeApprovalPending('root-call', 'root-tool')
		const childApproval = makeApprovalPending('child-call', 'child-tool')
		const grandchildApproval = makeApprovalPending('grand-call', 'grand-tool')

		const grandchild = makeState({ pending: [grandchildApproval] })
		const child = makeState({
			pending: [childApproval],
			subAgents: { gc: grandchild },
		})
		const root = makeState({
			pending: [rootApproval],
			subAgents: { child: child },
		})

		const next = withApprovals(root, [{ toolCallId: 'grand-call', approved: true }])

		// Root pending unchanged
		expect(next.pendingToolCalls).toHaveLength(1)
		expect(next.pendingToolCalls![0]!.toolCallId).toBe('root-call')

		// Child pending unchanged
		const updatedChild = next.subAgents!.child!
		expect(updatedChild.pendingToolCalls).toHaveLength(1)
		expect(updatedChild.pendingToolCalls![0]!.toolCallId).toBe('child-call')

		// Grandchild resolved
		const updatedGrandchild = updatedChild.subAgents!.gc!
		expect(updatedGrandchild.pendingToolCalls).toBeUndefined()
		expect(updatedGrandchild.approvalHistory).toHaveLength(1)
		expect(updatedGrandchild.approvalHistory![0]!.toolCallId).toBe('grand-call')
	})
})

// ─── withApprovals — partial approval across levels ──────────────────────────

describe('withApprovals() — partial approval across levels', () => {
	test('approve root + grandchild in same call; child remains pending', () => {
		const rootApproval = makeApprovalPending('root-call', 'root-tool')
		const childApproval = makeApprovalPending('child-call', 'child-tool')
		const grandchildApproval = makeApprovalPending('grand-call', 'grand-tool')

		const grandchild = makeState({ pending: [grandchildApproval] })
		const child = makeState({
			pending: [childApproval],
			subAgents: { gc: grandchild },
		})
		const root = makeState({
			pending: [rootApproval],
			subAgents: { child: child },
		})

		const next = withApprovals(root, [
			{ toolCallId: 'root-call', approved: true },
			{ toolCallId: 'grand-call', approved: true },
		])

		// Root resolved
		expect(next.pendingToolCalls).toBeUndefined()
		// Child still pending
		const updatedChild = next.subAgents!.child!
		expect(updatedChild.pendingToolCalls).toHaveLength(1)
		expect(updatedChild.pendingToolCalls![0]!.toolCallId).toBe('child-call')
		// Grandchild resolved
		const updatedGrandchild = updatedChild.subAgents!.gc!
		expect(updatedGrandchild.pendingToolCalls).toBeUndefined()
		expect(updatedGrandchild.approvalHistory).toHaveLength(1)
	})

	test('approve all levels simultaneously', () => {
		const rootApproval = makeApprovalPending('root-call', 'root-tool')
		const childApproval = makeApprovalPending('child-call', 'child-tool')
		const grandchildApproval = makeApprovalPending('grand-call', 'grand-tool')

		const grandchild = makeState({ pending: [grandchildApproval] })
		const child = makeState({
			pending: [childApproval],
			subAgents: { gc: grandchild },
		})
		const root = makeState({
			pending: [rootApproval],
			subAgents: { child: child },
		})

		const next = withApprovals(root, [
			{ toolCallId: 'root-call', approved: true },
			{ toolCallId: 'child-call', approved: true },
			{ toolCallId: 'grand-call', approved: true },
		])

		// All resolved
		expect(next.pendingToolCalls).toBeUndefined()
		const updatedChild = next.subAgents!.child!
		expect(updatedChild.pendingToolCalls).toBeUndefined()
		const updatedGrandchild = updatedChild.subAgents!.gc!
		expect(updatedGrandchild.pendingToolCalls).toBeUndefined()
	})

	test('withApprovals with empty decisions preserves entire tree structure', () => {
		const rootApproval = makeApprovalPending('root-call', 'root-tool')
		const childApproval = makeApprovalPending('child-call', 'child-tool')
		const child = makeState({ pending: [childApproval] })
		const root = makeState({
			pending: [rootApproval],
			subAgents: { 'child-1': child },
		})

		const next = withApprovals(root, [])

		// Nothing resolved
		expect(next.pendingToolCalls).toHaveLength(1)
		expect(next.subAgents!['child-1']?.pendingToolCalls).toHaveLength(1)
	})
})

// ─── PendingToolCall subAgent variant ────────────────────────────────────────

describe('PendingToolCall — subAgent variant', () => {
	test('subAgent pending entry has correct shape', () => {
		const entry = makeSubAgentPending('tc-1', 'subagent', 'worker-agent-1', 'code-writer')
		expect(entry.type).toBe('subAgent')
		if (entry.type === 'subAgent') {
			expect(entry.agentId).toBe('worker-agent-1')
			expect(entry.subAgentType).toBe('code-writer')
		}
		expect(entry.toolCallId).toBe('tc-1')
		expect(entry.toolName).toBe('subagent')
	})

	test('subAgent entry survives JSON round-trip', () => {
		const entry = makeSubAgentPending('tc-rt', 'subagent', 'agent-123', 'researcher')
		const restored = JSON.parse(JSON.stringify(entry)) as PendingToolCall
		expect(restored.type).toBe('subAgent')
		if (restored.type === 'subAgent') {
			expect(restored.agentId).toBe('agent-123')
			expect(restored.subAgentType).toBe('researcher')
		}
	})

	test('withApprovals leaves subAgent pending entries untouched', () => {
		const subAgentPending = makeSubAgentPending('tc-sa', 'subagent', 'agent-1', 'worker')
		const approvalPending = makeApprovalPending('tc-a', 'deploy')
		const state = makeState({ pending: [subAgentPending, approvalPending] })

		const next = withApprovals(state, [{ toolCallId: 'tc-a', approved: true }])

		// Approval resolved, subAgent untouched
		expect(next.pendingToolCalls).toHaveLength(1)
		expect(next.pendingToolCalls![0]!.type).toBe('subAgent')
		expect(next.pendingToolCalls![0]!.toolCallId).toBe('tc-sa')
	})

	test('getAllPendingApprovals excludes subAgent entries', () => {
		const subAgentPending = makeSubAgentPending('tc-sa', 'subagent', 'agent-1', 'worker')
		const approvalPending = makeApprovalPending('tc-a', 'deploy')
		const state = makeState({ pending: [subAgentPending, approvalPending] })

		const result = getAllPendingApprovals(state)
		expect(result).toHaveLength(1)
		expect(result[0]!.pending.toolCallId).toBe('tc-a')
	})
})

// ─── AgentPath type alias ─────────────────────────────────────────────────────

describe('AgentPath type alias', () => {
	test('AgentPath is an array of strings', () => {
		const path: AgentPath = ['child-1', 'grandchild-a']
		expect(Array.isArray(path)).toBe(true)
		expect(path).toHaveLength(2)
	})

	test('empty AgentPath represents root', () => {
		const root = makeState({})
		const path: AgentPath = []
		expect(getAgentState(root, path)).toBe(root)
	})
})

// ─── withApprovals — unmatched decision (no-op) ──────────────────────────────

describe('withApprovals() — unmatched decision', () => {
	test('decision targeting non-existent toolCallId is a no-op across entire tree', () => {
		const rootApproval = makeApprovalPending('root-call', 'root-tool')
		const childApproval = makeApprovalPending('child-call', 'child-tool')
		const child = makeState({ pending: [childApproval] })
		const root = makeState({
			pending: [rootApproval],
			subAgents: { 'child-1': child },
		})

		const next = withApprovals(root, [{ toolCallId: 'does-not-exist', approved: true }])

		// Root pending preserved
		expect(next.pendingToolCalls).toHaveLength(1)
		expect(next.pendingToolCalls![0]!.toolCallId).toBe('root-call')
		// Child pending preserved
		expect(next.subAgents!['child-1']?.pendingToolCalls).toHaveLength(1)
		expect(next.subAgents!['child-1']?.pendingToolCalls![0]!.toolCallId).toBe('child-call')
		// No approval history created
		expect(next.approvalHistory).toBeUndefined()
		expect(next.subAgents!['child-1']?.approvalHistory).toBeUndefined()
	})
})

// ─── withApprovals — multiple sibling sub-agents ─────────────────────────────

describe('withApprovals() — multiple sibling sub-agents', () => {
	test('decision resolves in one sibling; other sibling is unchanged', () => {
		const approval1 = makeApprovalPending('worker1-call', 'tool-1')
		const approval2 = makeApprovalPending('worker2-call', 'tool-2')
		const worker1 = makeState({ pending: [approval1] })
		const worker2 = makeState({ pending: [approval2] })
		const root = makeState({
			subAgents: { 'worker-1': worker1, 'worker-2': worker2 },
		})

		const next = withApprovals(root, [{ toolCallId: 'worker1-call', approved: true }])

		// worker-1 resolved
		const updatedWorker1 = next.subAgents!['worker-1']!
		expect(updatedWorker1.pendingToolCalls).toBeUndefined()
		expect(updatedWorker1.approvalHistory).toHaveLength(1)
		expect(updatedWorker1.approvalHistory![0]!.toolCallId).toBe('worker1-call')

		// worker-2 unchanged
		const updatedWorker2 = next.subAgents!['worker-2']!
		expect(updatedWorker2.pendingToolCalls).toHaveLength(1)
		expect(updatedWorker2.pendingToolCalls![0]!.toolCallId).toBe('worker2-call')
		expect(updatedWorker2.approvalHistory).toBeUndefined()
	})
})

// ─── withApprovals — toolState preserved through recursion ───────────────────

describe('withApprovals() — toolState preserved through recursion', () => {
	test('toolState at root and child levels survives recursive withApprovals', () => {
		const childApproval = makeApprovalPending('child-call', 'child-tool')
		const child: AgentState = {
			messages: [userMessage('child work')],
			pendingToolCalls: [childApproval],
			toolState: { 'child-todo': { items: ['a', 'b'] } },
		}
		const root: AgentState = {
			messages: [userMessage('root work')],
			toolState: { 'root-todo': { items: ['x'] } },
			subAgents: { 'child-1': child },
		}

		const next = withApprovals(root, [{ toolCallId: 'child-call', approved: true }])

		// Root toolState preserved
		expect(next.toolState).toEqual({ 'root-todo': { items: ['x'] } })
		// Child toolState preserved
		const updatedChild = next.subAgents!['child-1']!
		expect(updatedChild.toolState).toEqual({ 'child-todo': { items: ['a', 'b'] } })
		// Child approval resolved
		expect(updatedChild.pendingToolCalls).toBeUndefined()
	})
})

// ─── withApprovals — pre-existing approvalHistory at child appended ──────────

describe('withApprovals() — pre-existing approvalHistory at child appended', () => {
	test('new approval appends to existing child approvalHistory', () => {
		const childApproval = makeApprovalPending('child-call-2', 'child-tool-2')
		const existingHistory = {
			toolCallId: 'child-call-1',
			toolName: 'child-tool-1',
			input: { arg: 'old' },
			approval: {
				id: 'child-call-1',
				toolCallId: 'child-call-1',
				toolName: 'child-tool-1',
				input: { arg: 'old' },
				message: 'Please approve child-tool-1',
			},
			decision: { toolCallId: 'child-call-1', approved: true as const },
		}
		const child: AgentState = {
			messages: [userMessage('child work')],
			pendingToolCalls: [childApproval],
			approvalHistory: [existingHistory],
		}
		const root = makeState({ subAgents: { worker: child } })

		const next = withApprovals(root, [{ toolCallId: 'child-call-2', approved: true }])

		const updatedChild = next.subAgents!.worker!
		// History appended, not replaced
		expect(updatedChild.approvalHistory).toHaveLength(2)
		expect(updatedChild.approvalHistory![0]!.toolCallId).toBe('child-call-1')
		expect(updatedChild.approvalHistory![1]!.toolCallId).toBe('child-call-2')
	})
})

// ─── withApprovals — denial at grandchild level ──────────────────────────────

describe('withApprovals() — denial at grandchild level', () => {
	test('grandchild denial injects message into grandchild state', () => {
		const grandchildApproval = makeApprovalPending('grand-call', 'grand-tool')
		const grandchild = makeState({ pending: [grandchildApproval] })
		const child = makeState({ subAgents: { gc: grandchild } })
		const root = makeState({ subAgents: { child: child } })

		const next = withApprovals(root, [{ toolCallId: 'grand-call', approved: false, denialReason: 'Too risky' }])

		const updatedGrandchild = next.subAgents!.child!.subAgents!.gc!
		// Grandchild resolved
		expect(updatedGrandchild.pendingToolCalls).toBeUndefined()
		// Denial message injected into grandchild's messages
		expect(updatedGrandchild.messages.length).toBeGreaterThan(grandchild.messages.length)
		const lastMsg = updatedGrandchild.messages[updatedGrandchild.messages.length - 1]!
		expect(lastMsg.role).toBe('tool')
		// History recorded
		expect(updatedGrandchild.approvalHistory).toHaveLength(1)
		expect(updatedGrandchild.approvalHistory![0]!.decision.approved).toBe(false)
	})
})

// ─── withApprovals — mixed stopped + approval at child level ─────────────────

describe('withApprovals() — mixed types at child level', () => {
	test('child has stopped + approval; approve the approval, stopped stays', () => {
		const stoppedEntry = makeStoppedPending('child-stopped', 'tool-s')
		const approvalEntry = makeApprovalPending('child-approval', 'tool-a')
		const child = makeState({ pending: [stoppedEntry, approvalEntry] })
		const root = makeState({ subAgents: { worker: child } })

		const next = withApprovals(root, [{ toolCallId: 'child-approval', approved: true }])

		const updatedChild = next.subAgents!.worker!
		// Stopped entry preserved
		expect(updatedChild.pendingToolCalls).toHaveLength(1)
		expect(updatedChild.pendingToolCalls![0]!.type).toBe('stopped')
		expect(updatedChild.pendingToolCalls![0]!.toolCallId).toBe('child-stopped')
		// Approval resolved
		expect(updatedChild.approvalHistory).toHaveLength(1)
		expect(updatedChild.approvalHistory![0]!.toolCallId).toBe('child-approval')
	})
})

// ─── AgentState subAgents field — JSON round-trip ────────────────────────────

describe('AgentState with subAgents — JSON round-trip', () => {
	test('subAgents tree survives JSON.stringify → JSON.parse', () => {
		const grandchild: AgentState = {
			messages: [userMessage('grandchild')],
			pendingToolCalls: [makeApprovalPending('gc-call', 'gc-tool')],
		}
		const child: AgentState = {
			messages: [userMessage('child')],
			subAgents: { grandchild },
		}
		const root: AgentState = {
			messages: [userMessage('root')],
			subAgents: { child },
		}

		const restored = JSON.parse(JSON.stringify(root)) as AgentState
		expect(restored.subAgents?.child?.subAgents?.grandchild?.pendingToolCalls).toHaveLength(1)
		const gcPending = restored.subAgents!.child!.subAgents!.grandchild!.pendingToolCalls![0]!
		expect(gcPending.toolCallId).toBe('gc-call')
		expect(gcPending.type).toBe('approval')
	})
})
