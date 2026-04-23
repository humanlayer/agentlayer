import { describe, expect, test } from 'bun:test'
import type { LanguageModel } from 'ai'
import type { AgentConfig } from '@humanlayer/agentlayer-core'
import { createCodelayerAgent } from '../src/agent'

function createMockModel(modelId: string): LanguageModel {
	return {
		specificationVersion: 'v3',
		provider: 'mock',
		modelId,
		supportedUrls: {},
		async doGenerate() {
			return {
				content: [{ type: 'text', text: 'ok' }],
				finishReason: { unified: 'stop', raw: 'stop' },
				usage: {
					inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 0, text: 0, reasoning: 0 },
				},
				warnings: [],
			}
		},
		async doStream() {
			throw new Error('streaming not supported in test')
		},
	} as LanguageModel
}

function getAgentConfig(agent: object) {
	return agent as {
		tools?: Record<string, unknown>
		system?: string | string[]
		hooks?: AgentConfig['hooks']
		providerOptions?: Record<string, unknown>
	}
}

function getSystemEntries(agent: object): string[] {
	const system = getAgentConfig(agent).system
	if (!system) return []
	return Array.isArray(system) ? system : [system]
}

describe('createCodelayerAgent', () => {
	test('creates a standard claude agent with coding tools and subagent tool', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
		})
		const config = getAgentConfig(agent)

		expect(config.tools).toBeDefined()
		expect(config.tools?.bash).toBeDefined()
		expect(config.tools?.read).toBeDefined()
		expect(config.tools?.edit).toBeDefined()
		expect(config.tools?.write).toBeDefined()
		expect(config.tools?.agent).toBeDefined()
		expect(config.system?.length).toBeGreaterThan(0)
	})

	test('propagates context7 support into the subagent tool inventory', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
			context7ApiKey: 'context7-test-key',
		})
		const config = getAgentConfig(agent)
		const subagent = config.tools?.agent as { description?: string } | undefined

		expect(subagent?.description).toContain('library-researcher')
		expect(subagent?.description).toContain('implementer-agent')
	})

	test('creates an rlm codex agent without bash and with apply_patch', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('gpt-5.4'),
			cwd: '/tmp',
			rlm: true,
		})
		const config = getAgentConfig(agent)

		expect(config.tools?.bash).toBeUndefined()
		expect(config.tools?.apply_patch).toBeDefined()
		expect(config.tools?.agent).toBeDefined()
		expect(config.tools?.web_fetch).toBeDefined()
	})

	test('adds the tars persona prompt when requested', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
			tars: true,
		})
		const system = getSystemEntries(agent)
		expect(system.some((entry) => entry.includes('You are TARS'))).toBe(true)
	})

	test('adds the rpi specialist guidance when requested', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
			rpi: true,
		})
		const system = getSystemEntries(agent)
		expect(system.some((entry) => entry.includes('RPI specialist subagents are enabled'))).toBe(true)
	})
})
