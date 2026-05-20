import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModel } from 'ai'
import type { AgentConfig, PostToolUseHook, SubAgentConfig, Tool } from '@humanlayer/agentlayer-core'
import { saneDefaultOutputTruncationHooks } from '@humanlayer/agentlayer-filesystem/hooks'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import * as providerAuth from '@humanlayer/agentlayer-provider-auth'
import { buildProviderOptions, createCodelayerAgent } from '../src/agent'
import { createCodelayerAgent as rootCreateCodelayerAgent, createCodelayerCommand, DEFAULT_MODELS as rootDefaultModels, resolveExaApiKey, resolveModel } from '../src/index'
import { createCodingSubagentTool } from '../src/coding-subagent-tool'
import { parseProviderOptionOverrides } from '../src/command'
import { DEFAULT_MODELS } from '../src/providers'

let authStore = createMemoryAuthStore()

const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
const originalFireworksApiKey = process.env.FIREWORKS_API_KEY

beforeEach(() => {
	authStore = createMemoryAuthStore()
	mock.restore()
	spyOn(providerAuth, 'ensureFileAuthStore').mockImplementation(async () => authStore)
	delete process.env.ANTHROPIC_API_KEY
	delete process.env.FIREWORKS_API_KEY
})

afterEach(async () => {
	if (originalAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
	else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
	if (originalFireworksApiKey === undefined) delete process.env.FIREWORKS_API_KEY
	else process.env.FIREWORKS_API_KEY = originalFireworksApiKey
})

function createMockModel(modelId: string, provider = 'mock'): LanguageModel {
	return {
		specificationVersion: 'v3',
		provider,
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

async function createImageFixture(): Promise<string> {
	const tempDir = await mkdtemp(join(tmpdir(), 'codelayer-read-test-'))
	await writeFile(join(tempDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	return tempDir
}

async function withImageFixture<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = await createImageFixture()
	try {
		return await fn(cwd)
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}
}

async function expectReadToolSupportsPng(readTool: unknown) {
	const output = await (readTool as Tool<any, any>).execute({ file_path: 'image.png' }, {} as any)
	expect(output).toMatchObject({ type: 'image', mediaType: 'image/png' })
	expect(Buffer.from(output.content)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
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

function expectDefaultTruncationHooksFirst(hooks: AgentConfig['hooks']) {
	expect(hooks?.postToolUse?.slice(0, saneDefaultOutputTruncationHooks.length)).toEqual(
		saneDefaultOutputTruncationHooks,
	)
}

function getSubagents(tool: unknown): SubAgentConfig[] {
	return (tool as Tool & { subagents?: SubAgentConfig[] }).subagents ?? []
}

describe('provider resolution', () => {
	test('exports the public CodeLayer root surface', () => {
		expect(rootCreateCodelayerAgent).toBe(createCodelayerAgent)
		expect(createCodelayerCommand).toBeFunction()
		expect(rootDefaultModels).toBe(DEFAULT_MODELS)
		expect(resolveExaApiKey).toBeFunction()
		expect(resolveModel).toBeFunction()
		expect(DEFAULT_MODELS.firepass).toBe('accounts/fireworks/routers/kimi-k2p6-turbo')
	})

	test('resolves anthropic from ANTHROPIC_API_KEY before auth store', async () => {
		process.env.ANTHROPIC_API_KEY = 'env-anthropic-key'
		await authStore.set('anthropic', { kind: 'api', apiKey: 'auth-anthropic-key' })

		const model = await resolveModel('anthropic', 'claude-test')

		expect((model as { modelId: string }).modelId).toBe('claude-test')
		expect(providerAuth.ensureFileAuthStore).not.toHaveBeenCalled()
	})

	test('resolves anthropic from auth store when env is missing', async () => {
		await authStore.set('anthropic', { kind: 'api', apiKey: 'auth-anthropic-key' })

		const model = await resolveModel('anthropic', 'claude-test')

		expect((model as { modelId: string }).modelId).toBe('claude-test')
		expect(providerAuth.ensureFileAuthStore).toHaveBeenCalled()
	})

	test('resolves firepass from FIREWORKS_API_KEY before auth store', async () => {
		process.env.FIREWORKS_API_KEY = 'env-fireworks-key'
		await authStore.set('fireworks', { kind: 'api', apiKey: 'auth-fireworks-key' })

		const model = await resolveModel('firepass', 'fireworks-test')

		expect((model as { modelId: string }).modelId).toBe('fireworks-test')
		expect(providerAuth.ensureFileAuthStore).not.toHaveBeenCalled()
	})

	test('resolves firepass from fireworks auth store when env is missing', async () => {
		await authStore.set('fireworks', { kind: 'api', apiKey: 'auth-fireworks-key' })

		const model = await resolveModel('firepass', 'fireworks-test')

		expect((model as { modelId: string }).modelId).toBe('fireworks-test')
		expect(providerAuth.ensureFileAuthStore).toHaveBeenCalled()
	})

	test('continues to resolve codex and copilot from AgentLayer auth store', async () => {
		const codexModel = await resolveModel('codex', 'gpt-5.5')
		const copilotModel = await resolveModel('copilot', 'gpt-5.4')

		expect(codexModel).toBeDefined()
		expect(copilotModel).toBeDefined()
		expect(providerAuth.ensureFileAuthStore).toHaveBeenCalledTimes(2)
	})
})

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
				include: ['reasoning.encrypted_content'],
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

	test('uses low reasoning for gpt-5.5 codex by default', () => {
		const model = createMockModel('gpt-5.5')

		expect(buildProviderOptions(model).openai).toMatchObject({
			store: false,
			fastMode: false,
			include: ['reasoning.encrypted_content'],
			reasoningSummary: 'detailed',
			reasoningEffort: 'low',
		})
	})

	test('uses medium reasoning for gpt-5.4 codex by default', () => {
		const model = createMockModel('gpt-5.4')

		expect(buildProviderOptions(model).openai).toMatchObject({
			store: false,
			fastMode: false,
			include: ['reasoning.encrypted_content'],
			reasoningSummary: 'detailed',
			reasoningEffort: 'medium',
		})
	})

	test('uses high reasoning effort for kimi models', () => {
		const model = createMockModel(DEFAULT_MODELS.firepass)

		expect(buildProviderOptions(model).openai).toMatchObject({
			fastMode: false,
			reasoningEffort: 'high',
		})
	})

	test('allows disabling anthropic thinking defaults', () => {
		const model = createMockModel('claude-sonnet-4-5')

		expect(buildProviderOptions(model, { anthropic: { thinking: 'off' } }).anthropic).toEqual({
			cacheControl: { type: 'ephemeral' },
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

	test('hard-codes multimodal read for standard CodeLayer agents', async () => {
		await withImageFixture(async (cwd) => {
			const agent = await createCodelayerAgent({
				model: createMockModel('claude-sonnet-4-5'),
				cwd,
				subagentTool: { name: 'agent', description: 'test agent', inputSchema: {} as any, execute: async () => 'ok' } as any,
			})

			await expectReadToolSupportsPng(getAgentConfig(agent).tools?.read)
		})
	})

	test('hard-codes multimodal read for RLM direct read construction', async () => {
		await withImageFixture(async (cwd) => {
			const agent = await createCodelayerAgent({
				model: createMockModel('gpt-5.4'),
				cwd,
				rlm: true,
				subagentTool: { name: 'agent', description: 'test agent', inputSchema: {} as any, execute: async () => 'ok' } as any,
			})

			await expectReadToolSupportsPng(getAgentConfig(agent).tools?.read)
		})
	})

	test('custom codex provider does not trigger read modality inference', async () => {
		await withImageFixture(async (cwd) => {
			const agent = await createCodelayerAgent({
				model: createMockModel('gpt-5.5', 'openai.codex'),
				cwd,
				subagentTool: { name: 'agent', description: 'test agent', inputSchema: {} as any, execute: async () => 'ok' } as any,
			})

			await expectReadToolSupportsPng(getAgentConfig(agent).tools?.read)
		})
		expect(buildProviderOptions(createMockModel('gpt-5.5', 'openai.codex')).openai).toMatchObject({
			reasoningSummary: 'detailed',
			reasoningEffort: 'low',
			fastMode: false,
		})
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

	test('creates a gemini agent with gemini prompt and claude-style tools', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('gemini-2.5-pro'),
			cwd: '/tmp',
		})
		const config = getAgentConfig(agent)
		const system = getSystemEntries(agent)

		expect(config.tools?.write).toBeDefined()
		expect(config.tools?.edit).toBeDefined()
		expect(config.tools?.apply_patch).toBeUndefined()
		expect(system[0]).toContain('You are CodeLayer')
		expect(system[0]).toContain('an interactive CLI agent')
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

	test('prepends default truncation hooks before file-state and user hooks for standard agents', async () => {
		const userPostHook: PostToolUseHook = (ctx) => ctx.done()
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
			hooks: { postToolUse: [userPostHook] },
		})
		const postToolUse = getAgentConfig(agent).hooks?.postToolUse ?? []

		expectDefaultTruncationHooksFirst(getAgentConfig(agent).hooks)
		expect(postToolUse.at(-1)).toBe(userPostHook)
		expect(postToolUse.length).toBeGreaterThan(saneDefaultOutputTruncationHooks.length + 1)
	})

	test('prepends default truncation hooks before file-state and user hooks for rlm agents', async () => {
		const userPostHook: PostToolUseHook = (ctx) => ctx.done()
		const agent = await createCodelayerAgent({
			model: createMockModel('gpt-5.4'),
			cwd: '/tmp',
			rlm: true,
			hooks: { postToolUse: [userPostHook] },
		})
		const postToolUse = getAgentConfig(agent).hooks?.postToolUse ?? []

		expectDefaultTruncationHooksFirst(getAgentConfig(agent).hooks)
		expect(postToolUse.at(-1)).toBe(userPostHook)
		expect(postToolUse.length).toBeGreaterThan(saneDefaultOutputTruncationHooks.length + 1)
	})

	test('prepends default truncation hooks before inherited user hooks for subagents', async () => {
		const userPostHook: PostToolUseHook = (ctx) => ctx.done()
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
			hooks: { postToolUse: [userPostHook] },
		})
		const subagentTool = getAgentConfig(agent).tools?.agent
		const subagent = getSubagents(subagentTool).find((candidate) => candidate.name === 'general-purpose')
		const postToolUse = getAgentConfig(subagent?.agent ?? {}).hooks?.postToolUse ?? []

		expectDefaultTruncationHooksFirst(getAgentConfig(subagent?.agent ?? {}).hooks)
		expect(postToolUse.at(-1)).toBe(userPostHook)
		expect(postToolUse.length).toBeGreaterThan(saneDefaultOutputTruncationHooks.length + 1)
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
		expect(subagent?.description).toContain('rpi:implementer-agent')
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

	test('allows environment prompt controls', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
			environment: {
				date: new Date('2026-04-21T00:00:00Z'),
				platform: 'test-platform',
			},
		})
		const system = getSystemEntries(agent).join('\n')

		expect(system).toContain('Tue Apr 21 2026')
		expect(system).toContain('test-platform')
	})

	test('allows disabling the environment prompt', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
			environment: { include: false },
		})
		const system = getSystemEntries(agent).join('\n')

		expect(system).not.toContain('# Environment')
	})
})

describe('createCodingSubagentTool', () => {
	test('creates the standard subagent tool wrapper', async () => {
		const tool = await createCodingSubagentTool({
			cwd: '/tmp',
			model: createMockModel('gpt-5.4'),
		})

		expect(tool.name).toBe('subagent')
		expect(tool.description).toContain('general-purpose')
		expect(tool.description).toContain('rpi:implementer-agent')
		expect(tool.description).toContain('rpi:codebase-locator')
	})

	test('hard-codes multimodal read for coding subagents', async () => {
		await withImageFixture(async (cwd) => {
			const tool = await createCodingSubagentTool({
				cwd,
				model: createMockModel('claude-sonnet-4-5'),
			})
			const subagents = getSubagents(tool)

			for (const name of [
				'general-purpose',
				'bash',
				'rpi:implementer-agent',
				'rpi:codebase-locator',
				'rpi:codebase-analyzer',
				'rpi:codebase-pattern-finder',
			]) {
				const subagent = subagents.find((candidate) => candidate.name === name)
				await expectReadToolSupportsPng(getAgentConfig(subagent?.agent ?? {}).tools?.read)
			}
		})
	})

	test('includes library-researcher when documentation search keys are available', async () => {
		const tool = await createCodingSubagentTool({
			cwd: '/tmp',
			model: createMockModel('claude-sonnet-4-5'),
			context7ApiKey: 'context7-test-key',
		})

		expect(tool.description).toContain('library-researcher')
	})
})
