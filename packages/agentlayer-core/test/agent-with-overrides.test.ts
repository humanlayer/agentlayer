import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Agent, defineTool } from '../src'
import { mockModel } from './mocks'

// The Agent keeps `tools`/`system` private; read them via cast for assertions.
function agentTools(agent: unknown): Record<string, unknown> {
	return (agent as { tools: Record<string, unknown> }).tools
}
function agentSystem(agent: unknown): string | undefined {
	return (agent as { system: string | undefined }).system
}

const readTool = defineTool({
	name: 'read',
	description: 'fake read tool',
	input: z.object({ path: z.string() }),
	execute: async () => 'ok',
})
const writeTool = defineTool({
	name: 'write',
	description: 'fake write tool',
	input: z.object({ path: z.string(), content: z.string() }),
	execute: async () => 'ok',
})

function baseAgent(): Agent {
	return new Agent({
		model: mockModel([]),
		system: ['base system prompt'],
		tools: { read: readTool },
	})
}

describe('Agent.withOverrides', () => {
	test('merges extra tools and appends system prompts into a NEW agent', () => {
		const base = baseAgent()
		const next = base.withOverrides({
			tools: { write: writeTool },
			system: ['PERSIST YOUR FINDINGS to research/NN-topic.md'],
		})

		// A new instance — the original is untouched.
		expect(next).not.toBe(base)
		expect(Object.keys(agentTools(base))).toEqual(['read'])
		expect(agentSystem(base)).toBe('base system prompt')

		// The clone has the merged tools + appended system.
		expect(Object.keys(agentTools(next)).sort()).toEqual(['read', 'write'])
		expect(agentSystem(next)).toBe('base system prompt\n\nPERSIST YOUR FINDINGS to research/NN-topic.md')
	})

	test('returns the same instance when there is nothing to apply', () => {
		const base = baseAgent()
		expect(base.withOverrides({})).toBe(base)
		expect(base.withOverrides({ tools: {}, system: [] })).toBe(base)
	})

	test('can apply tools-only or system-only', () => {
		const base = baseAgent()

		const toolsOnly = base.withOverrides({ tools: { write: writeTool } })
		expect(Object.keys(agentTools(toolsOnly)).sort()).toEqual(['read', 'write'])
		expect(agentSystem(toolsOnly)).toBe('base system prompt')

		const systemOnly = base.withOverrides({ system: ['extra guidance'] })
		expect(Object.keys(agentTools(systemOnly))).toEqual(['read'])
		expect(agentSystem(systemOnly)).toBe('base system prompt\n\nextra guidance')
	})
})
