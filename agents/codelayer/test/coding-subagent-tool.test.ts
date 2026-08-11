import { describe, expect, test } from 'bun:test'
import type { Tool } from '@humanlayer/agentlayer-core'
import { createCodingSubagentTool } from '../src/coding-subagent-tool'
import { OUTLINE_IMPLEMENTER_AGENT_NAME } from '../src/rpi-agents'

const RESEARCH_SUBAGENT_NAMES = [
	'rpi:codebase-locator',
	'rpi:codebase-analyzer',
	'rpi:codebase-pattern-finder',
	'web-search-researcher',
]

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

function getAgentAssembly(agent: object) {
	return agent as { model: unknown; providerOptions?: unknown }
}

describe('createCodingSubagentTool', () => {
	test('exposes the complete strict Codex fork tool contract with model guidance', async () => {
		const tool = await createCodingSubagentTool({
			cwd: process.cwd(),
			model: 'codex-test' as any,
			system: 'test system prompt',
			mode: 'fork-dispatch-resume',
		})
		const input = tool.input as any
		const shape = input.shape as Record<string, { description?: string }>

		expect(Object.keys(shape)).toEqual([
			'description',
			'prompt',
			'agent_id',
			'fork_turns',
			'subagent_type',
			'skill',
		])
		expect(input.safeParse({ prompt: 'delegate this' }).success).toBe(true)
		expect(input.safeParse({ prompt: 'delegate this', unknown: true }).success).toBe(false)
		expect(shape.description?.description).toBe('Short description of the subagent task.')
		expect(shape.prompt?.description).toBe(
			'Task for the subagent. Custom-role tasks must be self-contained because they do not inherit the conversation.',
		)
		expect(shape.agent_id?.description).toBe(
			'Reserved for terminal subagent continuation, which is not available yet. Do not set this field.',
		)
		expect(shape.fork_turns?.description).toBe(
			'Conversation to inherit: "all", "none", or a positive integer string such as "3". Omitted means "all". Do not combine with agent_id or subagent_type.',
		)
		expect(shape.subagent_type?.description).toBe(
			'Start a registered specialist without inheriting the calling agent conversation. Do not combine with agent_id or fork_turns.',
		)
		expect(shape.skill?.description).toBe('Optional skill to preload into the subagent.')
		expect(tool.description).toContain('Omit agent_id, fork_turns, and subagent_type')
		expect(tool.description).toContain('Set subagent_type to start a fresh registered specialist')
		expect(tool.description).toContain('Terminal continuation is not available yet; do not set agent_id')
		expect(tool.description).not.toContain('continue a child ID returned by an earlier result')
	})

	test('preserves the required specialist selector outside Codex fork mode', async () => {
		const tool = await createCodingSubagentTool({
			cwd: process.cwd(),
			model: 'claude-test' as any,
			system: 'test system prompt',
			mode: 'specialists',
		})

		expect(tool.input.safeParse({ description: 'small task', prompt: 'work' }).success).toBe(false)
		expect(
			tool.input.safeParse({ description: 'small task', prompt: 'work', subagent_type: 'general-purpose' }).success,
		).toBe(true)
	})

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

	test('applies the grouped research override only to designated research agents', async () => {
		const rootModel = { modelId: 'gpt-5.6-sol' } as any
		const researchModel = { modelId: 'gpt-5.6-terra' } as any
		const rootProviderOptions = () => ({ mock: { marker: 'root' } })
		const outlineProviderOptions = () => ({ mock: { marker: 'outline' } })
		const researchProviderOptions = () => ({ mock: { marker: 'research' } })
		const tool = await createCodingSubagentTool({
			cwd: process.cwd(),
			model: rootModel,
			system: 'test system prompt',
			context7ApiKey: 'test-context7-key',
			providerOptions: rootProviderOptions,
			outlineImplementerProviderOptions: outlineProviderOptions,
			research: { model: researchModel, providerOptions: researchProviderOptions },
		})

		for (const subagent of tool.subagents) {
			const assembly = getAgentAssembly(subagent.agent)
			if (RESEARCH_SUBAGENT_NAMES.includes(subagent.name)) {
				expect(assembly.model, subagent.name).toBe(researchModel)
				expect(assembly.providerOptions, subagent.name).toBe(researchProviderOptions)
			} else if (subagent.name === OUTLINE_IMPLEMENTER_AGENT_NAME) {
				expect(assembly.model, subagent.name).toBe(rootModel)
				expect(assembly.providerOptions, subagent.name).toBe(outlineProviderOptions)
			} else {
				expect(assembly.model, subagent.name).toBe(rootModel)
				expect(assembly.providerOptions, subagent.name).toBe(rootProviderOptions)
			}
		}
	})

	test('keeps every subagent on the root assembly when research override is omitted', async () => {
		const rootModel = { modelId: 'gpt-5.5' } as any
		const rootProviderOptions = () => ({ mock: { marker: 'root' } })
		const tool = await createCodingSubagentTool({
			cwd: process.cwd(),
			model: rootModel,
			system: 'test system prompt',
			providerOptions: rootProviderOptions,
		})

		for (const subagent of tool.subagents) {
			const assembly = getAgentAssembly(subagent.agent)
			expect(assembly.model, subagent.name).toBe(rootModel)
			expect(assembly.providerOptions, subagent.name).toBe(rootProviderOptions)
		}
	})
})
