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
		system?: string[]
		hooks?: AgentConfig['hooks']
		providerOptions?: Record<string, unknown>
	}
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
})
