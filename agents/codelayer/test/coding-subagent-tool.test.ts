import { describe, expect, test } from 'bun:test'
import type { Tool } from '@humanlayer/agentlayer-core'
import { createCodingSubagentTool } from '../src/coding-subagent-tool'
import { OUTLINE_IMPLEMENTER_AGENT_NAME } from '../src/rpi-agents'

const EXPECTED_SUBAGENT_NAMES = [
	'general-purpose',
	'bash',
	'rpi:implementer-agent',
	'rpi:outline-implementer-agent',
	'rpi:codebase-locator',
	'rpi:codebase-analyzer',
	'rpi:codebase-pattern-finder',
	'web-search-researcher',
	'library-researcher',
]

function getAgentTools(agent: object): Record<string, Tool<any, any>> {
	return (agent as { tools: Record<string, Tool<any, any>> }).tools
}

describe('createCodingSubagentTool', () => {
	test('includes the outline implementer sub-agent once', async () => {
		const tool = await createCodingSubagentTool({
			cwd: process.cwd(),
			model: 'claude-test' as any,
			system: 'test system prompt',
		})

		const subagents = tool.subagents.filter((agent) => agent.name === OUTLINE_IMPLEMENTER_AGENT_NAME)

		expect(OUTLINE_IMPLEMENTER_AGENT_NAME).toBe('rpi:outline-implementer-agent')
		expect(subagents).toHaveLength(1)
		expect(subagents[0]?.description).toContain('Implements structure outlines')
	})

	test('shares the configured skill tool with every sub-agent', async () => {
		const skillTool = {
			name: 'skill',
			description: 'test skill tool',
			inputSchema: {},
			execute: async () => 'ok',
		} as unknown as Tool<any, any>
		const tool = await createCodingSubagentTool({
			cwd: process.cwd(),
			model: 'claude-test' as any,
			system: 'test system prompt',
			skillTool,
			context7ApiKey: 'test-context7-key',
		})

		expect(tool.subagents.map(({ name }) => name)).toEqual(EXPECTED_SUBAGENT_NAMES)
		for (const subagent of tool.subagents) {
			expect(getAgentTools(subagent.agent).skill).toBe(skillTool)
		}
	})

	test('resolves one shared skill tool when none is configured', async () => {
		const tool = await createCodingSubagentTool({
			cwd: process.cwd(),
			model: 'claude-test' as any,
			system: 'test system prompt',
			context7ApiKey: 'test-context7-key',
		})
		const skillTools = tool.subagents.map(({ agent }) => getAgentTools(agent).skill)

		expect(tool.subagents.map(({ name }) => name)).toEqual(EXPECTED_SUBAGENT_NAMES)
		expect(skillTools.every(Boolean)).toBe(true)
		expect(new Set(skillTools)).toHaveLength(1)
	})
})
