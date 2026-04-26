import { describe, expect, test } from 'bun:test'
import type { LanguageModel } from 'ai'
import type { AgentConfig } from '@humanlayer/agentlayer-core'
import { buildProviderOptions, createCodelayerAgent } from '../src/agent'
import { parseProviderOptionOverrides } from '../src/command'
import { DEFAULT_MODELS } from '../src/providers'

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
	test('uses gpt-5.4 as the default copilot model', () => {
		expect(DEFAULT_MODELS.copilot).toBe('gpt-5.4')
	})

	test('builds provider options with reasoning and fast mode overrides', () => {
		const model = createMockModel('gpt-5.4')
		const overrides = parseProviderOptionOverrides([
			'reasoningEffort=medium',
			'reasoningSummary=detailed',
			'fastMode=true',
			'anthropic.thinking=enabled',
			'anthropic.budgetTokens=1234',
		])

		expect(buildProviderOptions(model, overrides)).toEqual({
			anthropic: {
				thinking: { type: 'enabled', budgetTokens: 1234 },
				cacheControl: { type: 'ephemeral' },
			},
			openai: {
				store: false,
				reasoningSummary: 'detailed',
				reasoningEffort: 'medium',
				fastMode: true,
			},
			copilot: {
				reasoningEffort: 'medium',
				reasoningSummary: 'detailed',
			},
		})
	})

	test('enables codex fast mode by default', () => {
		const model = createMockModel('gpt-5.5')

		expect(buildProviderOptions(model).openai).toMatchObject({
			fastMode: true,
			reasoningSummary: 'detailed',
			reasoningEffort: 'low',
		})
	})

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
		expect(config.tools?.list).toBeDefined()
		expect(config.tools?.grep).toBeDefined()
		expect(config.tools?.glob).toBeDefined()
		expect(config.tools?.web_fetch).toBeDefined()
		expect(config.tools?.agent).toBeDefined()
		expect(config.system?.length).toBeGreaterThan(0)
	})

	test('creates a standard gpt agent with codex apply_patch tools', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('gpt-4.1'),
			cwd: '/tmp',
		})
		const config = getAgentConfig(agent)

		expect(config.tools?.apply_patch).toBeDefined()
		expect(config.tools?.edit).toBeUndefined()
		expect(config.tools?.write).toBeUndefined()
		expect(config.tools?.bash).toBeDefined()
		expect(config.tools?.read).toBeDefined()
		expect(config.tools?.agent).toBeDefined()
	})

	test('allows disabling default tools', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
			tools: { bash: false, webFetch: false },
		})
		const config = getAgentConfig(agent)

		expect(config.tools?.bash).toBeUndefined()
		expect(config.tools?.web_fetch).toBeUndefined()
		expect(config.tools?.read).toBeDefined()
		expect(config.tools?.agent).toBeDefined()
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
		expect(config.tools?.read).toBeDefined()
		expect(config.tools?.apply_patch).toBeDefined()
		expect(config.tools?.list).toBeUndefined()
		expect(config.tools?.grep).toBeUndefined()
		expect(config.tools?.glob).toBeUndefined()
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
