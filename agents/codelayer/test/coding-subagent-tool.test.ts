import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineTool } from '@humanlayer/agentlayer-core'
import { createCodingSubagentTool } from '../src/coding-subagent-tool'
import { CODEBASE_ANALYZER_NAME, OUTLINE_IMPLEMENTER_AGENT_NAME } from '../src/rpi-agents'

// The Agent stores `tools`/`system` privately; read them via cast for assertions.
function agentTools(agent: unknown): Record<string, unknown> {
	return (agent as { tools: Record<string, unknown> }).tools
}
function agentSystem(agent: unknown): string {
	return (agent as { system: string }).system
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

	describe('subagentOverrides', () => {
		const fakeWrite = defineTool({
			name: 'write',
			description: 'fake write tool for tests',
			input: z.object({ file_path: z.string(), content: z.string() }),
			execute: async () => 'ok',
		})

		test('merges override tools and appends override system prompts for the named subagent', async () => {
			const tool = await createCodingSubagentTool({
				cwd: process.cwd(),
				model: 'claude-test' as any,
				system: 'base system prompt',
				subagentOverrides: {
					[CODEBASE_ANALYZER_NAME]: {
						tools: { write: fakeWrite },
						system: ['PERSIST YOUR FINDINGS to research/NN-topic.md'],
					},
				},
			})

			const analyzer = tool.subagents.find((a) => a.name === CODEBASE_ANALYZER_NAME)?.agent
			expect(analyzer).toBeDefined()
			expect(Object.keys(agentTools(analyzer))).toContain('write')
			// original tools are preserved alongside the injected one
			expect(Object.keys(agentTools(analyzer))).toContain('read')
			expect(agentSystem(analyzer)).toContain('PERSIST YOUR FINDINGS')
		})

		test('leaves non-targeted subagents untouched', async () => {
			const tool = await createCodingSubagentTool({
				cwd: process.cwd(),
				model: 'claude-test' as any,
				system: 'base system prompt',
				subagentOverrides: {
					[CODEBASE_ANALYZER_NAME]: {
						tools: { write: fakeWrite },
						system: ['PERSIST YOUR FINDINGS'],
					},
				},
			})

			const locator = tool.subagents.find((a) => a.name === 'rpi:codebase-locator')?.agent
			expect(locator).toBeDefined()
			expect(Object.keys(agentTools(locator))).not.toContain('write')
			expect(agentSystem(locator)).not.toContain('PERSIST YOUR FINDINGS')
		})

		test('is a no-op when no overrides are supplied', async () => {
			const tool = await createCodingSubagentTool({
				cwd: process.cwd(),
				model: 'claude-test' as any,
				system: 'base system prompt',
			})

			const analyzer = tool.subagents.find((a) => a.name === CODEBASE_ANALYZER_NAME)?.agent
			expect(Object.keys(agentTools(analyzer))).not.toContain('write')
		})
	})
})
