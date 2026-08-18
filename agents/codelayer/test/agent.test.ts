import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModel } from 'ai'
import type { AgentConfig, PostToolUseHook, SubAgentConfig, Tool } from '@humanlayer/agentlayer-core'
import { createAgentFilesystemHooks } from '@humanlayer/agentlayer-filesystem'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import * as providerAuth from '@humanlayer/agentlayer-provider-auth'
import * as codexProvider from '@humanlayer/agentlayer-provider-openai-codex'
import {
	buildProviderOptions,
	createCodelayerAgent,
	createCodelayerProviderOptionsFactory,
	LOW_ANTHROPIC_BUDGET,
	subagentThinkingOverrides,
} from '../src/agent'
import * as agentModule from '../src/agent'
import * as providersModule from '../src/providers'
import * as skillToolModule from '@humanlayer/agentlayer-filesystem/tools'
import { createCodelayerAgent as rootCreateCodelayerAgent, createCodelayerCommand, DEFAULT_MODELS as rootDefaultModels, resolveExaApiKey, resolveModel } from '../src/index'
import { createCodingSubagentTool } from '../src/coding-subagent-tool'
import { applyCliThinkingOverride, parseProviderOptionOverrides } from '../src/command'
import { DEFAULT_MODELS } from '../src/providers'

let authStore = createMemoryAuthStore()

const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
const originalFireworksApiKey = process.env.FIREWORKS_API_KEY
const originalCodexProvider = process.env.CODEX_PROVIDER
const codexOverrideEnvironmentNames = [
	'CODELAYER_CODEX_BASE_URL',
	'CODELAYER_CODEX_API_KEY',
	'CODELAYER_CODEX_API_KEY_HEADER',
	'CODELAYER_CODEX_MODEL',
] as const
const originalCodexOverrideEnvironment = Object.fromEntries(
	codexOverrideEnvironmentNames.map((name) => [name, process.env[name]]),
) as Record<(typeof codexOverrideEnvironmentNames)[number], string | undefined>

beforeEach(() => {
	authStore = createMemoryAuthStore()
	mock.restore()
	spyOn(providerAuth, 'ensureFileAuthStore').mockImplementation(async () => authStore)
	delete process.env.ANTHROPIC_API_KEY
	delete process.env.FIREWORKS_API_KEY
	delete process.env.CODEX_PROVIDER
	for (const name of codexOverrideEnvironmentNames) delete process.env[name]
})

afterEach(async () => {
	mock.restore()
	if (originalAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
	else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
	if (originalFireworksApiKey === undefined) delete process.env.FIREWORKS_API_KEY
	else process.env.FIREWORKS_API_KEY = originalFireworksApiKey
	if (originalCodexProvider === undefined) delete process.env.CODEX_PROVIDER
	else process.env.CODEX_PROVIDER = originalCodexProvider
	for (const name of codexOverrideEnvironmentNames) {
		const value = originalCodexOverrideEnvironment[name]
		if (value === undefined) delete process.env[name]
		else process.env[name] = value
	}
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
		model?: LanguageModel
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

function expectFilesystemHooksBeforeUser(hooks: AgentConfig['hooks'], userPostHook: PostToolUseHook) {
	const postToolUse = hooks?.postToolUse ?? []
	const expectedFilesystemHookCount = createAgentFilesystemHooks({ cwd: '/tmp' }).postToolUse.length

	expect(postToolUse).toHaveLength(expectedFilesystemHookCount + 1)
	expect(postToolUse.at(-1)).toBe(userPostHook)
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

	test('resolves a complete custom Codex override before auth and private provider selection', async () => {
		process.env.CODELAYER_CODEX_BASE_URL = 'https://example.test/openai/v1'
		process.env.CODELAYER_CODEX_API_KEY = 'custom-test-key'
		process.env.CODELAYER_CODEX_MODEL = 'azure-coding-deployment'
		process.env.CODEX_PROVIDER = 'websockets'
		const sseSpy = spyOn(codexProvider, 'createCodexSseVendorProvider')
		const responsesSpy = spyOn(codexProvider, 'createCodexResponsesProvider')
		const websocketSpy = spyOn(codexProvider, 'createCodexEffectProvider')

		const model = await resolveModel('codex', 'gpt-5.6-sol')

		expect((model as { provider: string }).provider).toBe('custom-openai-responses')
		expect((model as { modelId: string }).modelId).toBe('gpt-5.6-sol')
		expect(providerAuth.ensureFileAuthStore).not.toHaveBeenCalled()
		expect(sseSpy).not.toHaveBeenCalled()
		expect(responsesSpy).not.toHaveBeenCalled()
		expect(websocketSpy).not.toHaveBeenCalled()
	})

	test('rejects partial custom Codex settings before auth or private provider selection', async () => {
		process.env.CODELAYER_CODEX_BASE_URL = 'https://example.test/openai/v1'
		const sseSpy = spyOn(codexProvider, 'createCodexSseVendorProvider')
		const responsesSpy = spyOn(codexProvider, 'createCodexResponsesProvider')
		const websocketSpy = spyOn(codexProvider, 'createCodexEffectProvider')

		await expect(resolveModel('codex', 'gpt-5.6-sol')).rejects.toThrow('CODELAYER_CODEX_API_KEY')
		delete process.env.CODELAYER_CODEX_BASE_URL
		process.env.CODELAYER_CODEX_API_KEY = 'custom-test-key'
		await expect(resolveModel('codex', 'gpt-5.6-sol')).rejects.toThrow('CODELAYER_CODEX_BASE_URL')
		expect(providerAuth.ensureFileAuthStore).not.toHaveBeenCalled()
		expect(sseSpy).not.toHaveBeenCalled()
		expect(responsesSpy).not.toHaveBeenCalled()
		expect(websocketSpy).not.toHaveBeenCalled()
	})

	test('keeps every private Codex transport available when the override is absent', async () => {
		const sseSpy = spyOn(codexProvider, 'createCodexSseVendorProvider')
		const responsesSpy = spyOn(codexProvider, 'createCodexResponsesProvider')
		const websocketSpy = spyOn(codexProvider, 'createCodexEffectProvider')

		await resolveModel('codex', 'gpt-5.5', { codexProviderMode: 'sse' })
		await resolveModel('codex', 'gpt-5.5', { codexProviderMode: 'aisdk_responses' })
		await resolveModel('codex', 'gpt-5.5', { codexProviderMode: 'websockets' })

		expect(providerAuth.ensureFileAuthStore).toHaveBeenCalledTimes(3)
		expect(sseSpy).toHaveBeenCalledTimes(1)
		expect(responsesSpy).toHaveBeenCalledTimes(1)
		expect(websocketSpy).toHaveBeenCalledTimes(1)
	})

	test('defaults codex model resolution to the SSE provider', async () => {
		const providerSpy = spyOn(codexProvider, 'createCodexSseVendorProvider')

		const model = await resolveModel('codex', 'gpt-5.5')

		expect(model).toBeDefined()
		expect(providerSpy).toHaveBeenCalled()
	})

	test('forwards codex diagnostics context into the Codex SSE provider factory', async () => {
		const providerSpy = spyOn(codexProvider, 'createCodexSseVendorProvider')
		const codexDiagnostics = {
			annotations: { sessionId: 'session-xyz', model: 'gpt-5.5', provider: 'codex' },
			onEvent: () => {},
		}

		const model = await resolveModel('codex', 'gpt-5.5', { codexDiagnostics })

		expect(model).toBeDefined()
		expect(providerSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				diagnostics: codexDiagnostics,
				sessionId: 'session-xyz',
			}),
		)
	})

	test('respects explicit codex provider mode from caller context', async () => {
		const providerSpy = spyOn(codexProvider, 'createCodexResponsesProvider')

		const model = await resolveModel('codex', 'gpt-5.5', { codexProviderMode: 'aisdk_responses' })

		expect(model).toBeDefined()
		expect(providerSpy).toHaveBeenCalled()
	})

	test('respects CODEX_PROVIDER when caller context does not set a mode', async () => {
		process.env.CODEX_PROVIDER = 'websockets'
		const providerSpy = spyOn(codexProvider, 'createCodexEffectProvider')

		const model = await resolveModel('codex', 'gpt-5.5')

		expect(model).toBeDefined()
		expect(providerSpy).toHaveBeenCalled()
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

	test('uses medium reasoning for gpt-5.5 codex by default', () => {
		const model = createMockModel('gpt-5.5')

		expect(buildProviderOptions(model).openai).toMatchObject({
			store: false,
			fastMode: false,
			include: ['reasoning.encrypted_content'],
			reasoningSummary: 'detailed',
			reasoningEffort: 'medium',
		})
	})

	test('keeps selected-model reasoning but strips fast mode and service tier for custom Responses', () => {
		const model = createMockModel('gpt-5.6-sol', 'custom-openai-responses')

		const options = buildProviderOptions(model, {
			codex: {
				reasoningEffort: 'high',
				reasoningSummary: 'detailed',
				fastMode: true,
				serviceTier: 'priority',
				promptCacheKey: 'session-custom',
			},
		}).openai

		expect(options).toMatchObject({
			store: false,
			include: ['reasoning.encrypted_content'],
			reasoningEffort: 'high',
			reasoningSummary: 'detailed',
			promptCacheKey: 'session-custom',
			forceReasoning: true,
		})
		expect(options).not.toHaveProperty('fastMode')
		expect(options).not.toHaveProperty('serviceTier')
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

	test('uses medium reasoning effort for kimi models by default', () => {
		const model = createMockModel(DEFAULT_MODELS.firepass)

		expect(buildProviderOptions(model).openai).toMatchObject({
			fastMode: false,
			reasoningEffort: 'medium',
		})
	})

	test('uses medium adaptive thinking effort for modern anthropic models by default', () => {
		const opus47 = createMockModel('claude-opus-4-7')
		const sonnet46 = createMockModel('claude-sonnet-4-6')

		expect(buildProviderOptions(opus47).anthropic).toEqual({
			thinking: { type: 'adaptive', display: 'summarized' },
			effort: 'medium',
			cacheControl: { type: 'ephemeral' },
		})
		expect(buildProviderOptions(sonnet46).anthropic).toEqual({
			thinking: { type: 'adaptive' },
			effort: 'medium',
			cacheControl: { type: 'ephemeral' },
		})
	})

	test('passes promptCacheKey through codex overrides to openai provider options', () => {
		const model = createMockModel('gpt-5.5')

		const result = buildProviderOptions(model, {
			codex: { promptCacheKey: 'session-abc-123' },
		})

		expect(result.openai).toMatchObject({
			promptCacheKey: 'session-abc-123',
		})
	})

	test('uses a unique stable fallback prompt cache key per factory', () => {
		const model = createMockModel('gpt-5.5')
		const factory = createCodelayerProviderOptionsFactory(model)
		const otherFactory = createCodelayerProviderOptionsFactory(model)

		const first = factory({ runId: 'parent' })?.openai as { promptCacheKey?: string }
		const second = factory({ runId: 'subagent' })?.openai as { promptCacheKey?: string }
		const other = otherFactory({ runId: 'other' })?.openai as { promptCacheKey?: string }

		expect(first.promptCacheKey).toBeString()
		expect(first.promptCacheKey).toBe(second.promptCacheKey)
		expect(first.promptCacheKey).not.toBe(other.promptCacheKey)
	})

	test('prefers the run key, then configured override, then stable fallback', () => {
		const model = createMockModel('gpt-5.5')
		const factory = createCodelayerProviderOptionsFactory(model, {
			codex: { promptCacheKey: 'session-abc-123' },
		})

		const runKey = factory({ runId: 'first', promptCacheKey: 'run-session' })?.openai as {
			promptCacheKey?: string
		}
		const configured = factory({ runId: 'second' })?.openai as { promptCacheKey?: string }
		const fallback = createCodelayerProviderOptionsFactory(model)({ runId: 'third' })?.openai as {
			promptCacheKey?: string
		}

		expect(runKey.promptCacheKey).toBe('run-session')
		expect(configured.promptCacheKey).toBe('session-abc-123')
		expect(fallback.promptCacheKey).toBeString()
		expect(fallback.promptCacheKey).not.toBe(configured.promptCacheKey)
	})

	test('bounds overlong explicit, configured, and run prompt cache keys', () => {
		const model = createMockModel('gpt-5.5')
		const longKey = 'explicit-key-'.repeat(20)
		const configuredFactory = createCodelayerProviderOptionsFactory(model, {
			codex: { promptCacheKey: longKey },
		})
		const explicitFactory = createCodelayerProviderOptionsFactory(model, {
			codex: { promptCacheKey: longKey },
		})
		const runFactory = createCodelayerProviderOptionsFactory(model)
		const configured = configuredFactory({ runId: 'configured' })?.openai as { promptCacheKey: string }
		const explicit = explicitFactory({ runId: 'explicit' })?.openai as { promptCacheKey: string }
		const run = runFactory({ runId: 'run', promptCacheKey: `${longKey}-run` })?.openai as {
			promptCacheKey: string
		}

		expect(configured.promptCacheKey).toHaveLength(43)
		expect(explicit.promptCacheKey).toBe(configured.promptCacheKey)
		expect(run.promptCacheKey.length).toBeLessThanOrEqual(64)
		expect(
			(runFactory({ runId: 'uuid', promptCacheKey: '019f8ace-744b-7b97-8b4f-7e5b1ac44a87' })?.openai as {
				promptCacheKey: string
			}).promptCacheKey,
		).toBe('019f8ace-744b-7b97-8b4f-7e5b1ac44a87')
	})

	test('includes reasoning.encrypted_content in include by default', () => {
		const model = createMockModel('gpt-5.5')

		const result = buildProviderOptions(model)

		expect(result.openai.include).toEqual(['reasoning.encrypted_content'])
	})

	test('applies medium CLI thinking by default for codex', () => {
		const model = createMockModel('gpt-5.5')
		const overrides = applyCliThinkingOverride({
			provider: 'codex',
			modelId: 'gpt-5.5',
			thinking: undefined,
			overrides: {},
		})

		expect(buildProviderOptions(model, overrides).openai).toMatchObject({
			reasoningSummary: 'detailed',
			reasoningEffort: 'medium',
		})
	})

	test('applies explicit CLI thinking for gpt-5.5 codex', () => {
		const model = createMockModel('gpt-5.5')
		const overrides = applyCliThinkingOverride({
			provider: 'codex',
			modelId: 'gpt-5.5',
			thinking: 'xhigh',
			overrides: {},
		})

		expect(buildProviderOptions(model, overrides).openai.reasoningEffort).toBe('xhigh')
	})

	test('applies explicit CLI thinking for firepass kimi models', () => {
		const model = createMockModel(DEFAULT_MODELS.firepass)
		const overrides = applyCliThinkingOverride({
			provider: 'firepass',
			modelId: DEFAULT_MODELS.firepass,
			thinking: 'custom-fireworks-effort',
			overrides: {},
		})

		expect(buildProviderOptions(model, overrides).openai.reasoningEffort).toBe('custom-fireworks-effort')
	})

	test('uses adaptive thinking with effort for opus 4.6', () => {
		const model = createMockModel('claude-opus-4-6')
		const overrides = applyCliThinkingOverride({
			provider: 'anthropic',
			modelId: 'claude-opus-4-6',
			thinking: 'high',
			overrides: {},
		})

		expect(buildProviderOptions(model, overrides).anthropic).toEqual({
			thinking: { type: 'adaptive' },
			effort: 'high',
			cacheControl: { type: 'ephemeral' },
		})
	})

	test('uses summarized adaptive thinking with effort for opus 4.7', () => {
		const model = createMockModel('claude-opus-4-7')
		const overrides = applyCliThinkingOverride({
			provider: 'anthropic',
			modelId: 'claude-opus-4-7',
			thinking: 'xhigh',
			overrides: {},
		})

		expect(buildProviderOptions(model, overrides).anthropic).toEqual({
			thinking: { type: 'adaptive', display: 'summarized' },
			effort: 'xhigh',
			cacheControl: { type: 'ephemeral' },
		})
	})

	test('uses summarized adaptive thinking for opus 4.8 by default without changing provider defaults', () => {
		const model = createMockModel('claude-opus-4-8')

		expect(DEFAULT_MODELS.anthropic).toBe('claude-opus-4-5')
		expect(buildProviderOptions(model).anthropic).toEqual({
			thinking: { type: 'adaptive', display: 'summarized' },
			effort: 'medium',
			cacheControl: { type: 'ephemeral' },
		})
	})

	test('uses summarized adaptive thinking with explicit xhigh CLI effort for opus 4.8', () => {
		const model = createMockModel('claude-opus-4-8')
		const overrides = applyCliThinkingOverride({
			provider: 'anthropic',
			modelId: 'claude-opus-4-8',
			thinking: 'xhigh',
			overrides: {},
		})

		expect(buildProviderOptions(model, overrides).anthropic).toEqual({
			thinking: { type: 'adaptive', display: 'summarized' },
			effort: 'xhigh',
			cacheControl: { type: 'ephemeral' },
		})
	})

	test('supports dot-form opus 4.8 CLI thinking validation', () => {
		const model = createMockModel('claude-opus-4.8')
		const overrides = applyCliThinkingOverride({
			provider: 'anthropic',
			modelId: 'claude-opus-4.8',
			thinking: 'max',
			overrides: {},
		})

		expect(buildProviderOptions(model, overrides).anthropic).toEqual({
			thinking: { type: 'adaptive', display: 'summarized' },
			effort: 'max',
			cacheControl: { type: 'ephemeral' },
		})
	})

	test('uses summarized adaptive thinking for FABLE 5 by default', () => {
		const model = createMockModel('claude-fable-5')

		expect(buildProviderOptions(model).anthropic).toEqual({
			thinking: { type: 'adaptive', display: 'summarized' },
			effort: 'medium',
			cacheControl: { type: 'ephemeral' },
		})
	})

	test('supports effort up to max for FABLE 5', () => {
		const model = createMockModel('claude-fable-5')
		const overrides = applyCliThinkingOverride({
			provider: 'anthropic',
			modelId: 'claude-fable-5',
			thinking: 'max',
			overrides: {},
		})

		expect(buildProviderOptions(model, overrides).anthropic).toEqual({
			thinking: { type: 'adaptive', display: 'summarized' },
			effort: 'max',
			cacheControl: { type: 'ephemeral' },
		})
	})

	test('rejects invalid known model thinking combinations', () => {
		expect(() =>
			applyCliThinkingOverride({
				provider: 'codex',
				modelId: 'gpt-5.5',
				thinking: 'max',
				overrides: {},
			}),
		).toThrow('Unsupported --thinking value "max"')

		expect(() =>
			applyCliThinkingOverride({
				provider: 'anthropic',
				modelId: 'claude-sonnet-4-6',
				thinking: 'xhigh',
				overrides: {},
			}),
		).toThrow('Unsupported --thinking value "xhigh"')

		expect(() =>
			applyCliThinkingOverride({
				provider: 'anthropic',
				modelId: 'claude-opus-4-8',
				thinking: 'extreme',
				overrides: {},
			}),
		).toThrow('Unsupported --thinking value "extreme"')
	})

	test('preserves explicit provider-option reasoning values over CLI defaults', () => {
		const model = createMockModel('gpt-5.5')
		const overrides = applyCliThinkingOverride({
			provider: 'codex',
			modelId: 'gpt-5.5',
			thinking: undefined,
			overrides: { codex: { reasoningEffort: 'low' } },
		})

		expect(buildProviderOptions(model, overrides).openai.reasoningEffort).toBe('low')
	})

	test('always sets store to false for openai options', () => {
		const model = createMockModel('gpt-5.5')

		const result = buildProviderOptions(model)

		expect(result.openai.store).toBe(false)
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
		expect(config.tools?.web_fetch).toBeDefined()
		expect(config.tools?.agent).toBeDefined()
		expect(config.system?.length).toBeGreaterThan(0)
		// glob, grep, list removed - agent uses bash for file discovery
		expect(config.tools?.list).toBeUndefined()
		expect(config.tools?.grep).toBeUndefined()
		expect(config.tools?.glob).toBeUndefined()
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
			reasoningEffort: 'medium',
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

	test('installs the filesystem hook chain once before user hooks for standard agents', async () => {
		const userPostHook: PostToolUseHook = (ctx) => ctx.done()
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
			hooks: { postToolUse: [userPostHook] },
		})
		const postToolUse = getAgentConfig(agent).hooks?.postToolUse ?? []

		expectFilesystemHooksBeforeUser(getAgentConfig(agent).hooks, userPostHook)
		expect(postToolUse).toHaveLength(8)
	})

	test('installs the filesystem hook chain once before user hooks for rlm agents', async () => {
		const userPostHook: PostToolUseHook = (ctx) => ctx.done()
		const agent = await createCodelayerAgent({
			model: createMockModel('gpt-5.4'),
			cwd: '/tmp',
			rlm: true,
			hooks: { postToolUse: [userPostHook] },
		})
		const postToolUse = getAgentConfig(agent).hooks?.postToolUse ?? []

		expectFilesystemHooksBeforeUser(getAgentConfig(agent).hooks, userPostHook)
		expect(postToolUse).toHaveLength(8)
	})

	test('installs the filesystem hook chain once before inherited user hooks for subagents', async () => {
		const userPostHook: PostToolUseHook = (ctx) => ctx.done()
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
			hooks: { postToolUse: [userPostHook] },
		})
		const subagentTool = getAgentConfig(agent).tools?.agent
		const subagent = getSubagents(subagentTool).find((candidate) => candidate.name === 'general-purpose')
		const postToolUse = getAgentConfig(subagent?.agent ?? {}).hooks?.postToolUse ?? []

		expectFilesystemHooksBeforeUser(getAgentConfig(subagent?.agent ?? {}).hooks, userPostHook)
		expect(postToolUse).toHaveLength(8)
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

	test('does not add broad delegation guidance when rpi specialists are requested', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
			rpi: true,
		})
		const system = getSystemEntries(agent)
		expect(system.some((entry) => entry.includes('RPI specialist subagents are enabled'))).toBe(false)
		expect(system.some((entry) => entry.includes('Prefer delegating specialized research'))).toBe(false)
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

describe('subagentThinkingOverrides', () => {
	test('throttles opus 4.5 via a reduced thinking budget', () => {
		const model = createMockModel('claude-opus-4-5')

		const overrides = subagentThinkingOverrides(model, {}, 'low')

		expect(overrides.anthropic?.thinking).toBe('enabled')
		expect(overrides.anthropic?.budgetTokens).toBe(2048)
		expect(LOW_ANTHROPIC_BUDGET).toBe(2048)
	})

	test('throttles adaptive opus 4.8 via effort', () => {
		const model = createMockModel('claude-opus-4-8')

		const overrides = subagentThinkingOverrides(model, {}, 'low')

		expect(overrides.anthropic?.effort).toBe('low')
		expect(overrides.anthropic?.thinking).toBeUndefined()
	})

	test('throttles codex gpt-5.5 via reasoning effort', () => {
		const model = createMockModel('gpt-5.5')

		const overrides = subagentThinkingOverrides(model, {}, 'low')

		expect(overrides.codex?.reasoningEffort).toBe('low')
	})

	test('routes haiku through the adaptive effort branch (no 4.5 budget branch)', () => {
		const model = createMockModel('claude-haiku-4-5')

		// claude-haiku-4-5 matches the 4-5 substring; it uses extended thinking too.
		const haiku45 = subagentThinkingOverrides(model, {}, 'low')
		expect(haiku45.anthropic?.thinking).toBe('enabled')
		expect(haiku45.anthropic?.budgetTokens).toBe(2048)

		// a haiku model with no family-specific default falls into the effort branch.
		const plainHaiku = createMockModel('claude-haiku')
		const overrides = subagentThinkingOverrides(plainHaiku, {}, 'low')
		expect(overrides.anthropic?.effort).toBe('low')
		expect(overrides.anthropic?.thinking).toBeUndefined()
		expect(buildProviderOptions(plainHaiku, overrides).anthropic).toMatchObject({
			effort: 'low',
		})
	})

	test('throttles codex gpt-5.4-mini via reasoning effort (model-swap follow-on target)', () => {
		const model = createMockModel('gpt-5.4-mini')

		const overrides = subagentThinkingOverrides(model, {}, 'low')

		expect(overrides.codex?.reasoningEffort).toBe('low')
	})

	test('respects an explicit parent anthropic thinking off', () => {
		const model = createMockModel('claude-opus-4-5')

		const overrides = subagentThinkingOverrides(model, { anthropic: { thinking: 'off' } }, 'low')

		expect(overrides.anthropic?.thinking).toBe('off')
		expect(overrides.anthropic?.budgetTokens).toBeUndefined()
	})

	test('does not raise a parent codex effort already at or below the level', () => {
		const model = createMockModel('gpt-5.5')

		const kept = subagentThinkingOverrides(model, { codex: { reasoningEffort: 'low' } }, 'medium')
		expect(kept.codex?.reasoningEffort).toBe('low')

		const raised = subagentThinkingOverrides(model, { codex: { reasoningEffort: 'high' } }, 'low')
		expect(raised.codex?.reasoningEffort).toBe('low')
	})

	test('emits a reduced anthropic block through buildProviderOptions for opus 4.5', () => {
		const model = createMockModel('claude-opus-4-5')

		const result = buildProviderOptions(model, subagentThinkingOverrides(model, {}, 'low'))

		expect(result.anthropic).toEqual({
			thinking: { type: 'enabled', budgetTokens: 2048 },
			cacheControl: { type: 'ephemeral' },
		})
	})

	test('emits a reduced openai block through buildProviderOptions for codex', () => {
		const model = createMockModel('gpt-5.5')

		const result = buildProviderOptions(model, subagentThinkingOverrides(model, {}, 'low'))

		expect(result.openai.reasoningEffort).toBe('low')
	})

	test('throttles the sub-agent factory while the top-level agent keeps configured thinking', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-opus-4-5'),
			cwd: '/tmp',
		})
		const config = getAgentConfig(agent)

		// Top-level agent keeps the configured (default) thinking budget.
		const topOptions = (config.providerOptions as unknown as (ctx: { runId: string }) => Record<string, any>)({
			runId: 'parent',
		})
		expect(topOptions.anthropic).toMatchObject({
			thinking: { type: 'enabled', budgetTokens: 10000 },
		})

		// The sub-agent factory is throttled to the reduced budget.
		const subagentTool = config.tools?.agent
		const subagent = getSubagents(subagentTool).find((candidate) => candidate.name === 'general-purpose')
		const subProviderOptions = getAgentConfig(subagent?.agent ?? {}).providerOptions as unknown as (ctx: {
			runId: string
		}) => Record<string, any>
		const subOptions = subProviderOptions({ runId: 'subagent' })
		expect(subOptions.anthropic).toMatchObject({
			thinking: { type: 'enabled', budgetTokens: 2048 },
		})
	})

	test('lets the outline implementer use parent codex effort while other sub-agents stay throttled', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('gpt-5.5'),
			cwd: '/tmp',
			providerOptionOverrides: {
				codex: {
					reasoningEffort: 'high',
					reasoningSummary: 'detailed',
				},
			},
		})
		const subagentTool = getAgentConfig(agent).tools?.agent
		const subagents = getSubagents(subagentTool)
		const generalPurpose = subagents.find((candidate) => candidate.name === 'general-purpose')
		const outlineImplementer = subagents.find((candidate) => candidate.name === 'rpi:outline-implementer-agent')

		const generalProviderOptions = getAgentConfig(generalPurpose?.agent ?? {}).providerOptions as unknown as (ctx: {
			runId: string
		}) => Record<string, any>
		const outlineProviderOptions = getAgentConfig(outlineImplementer?.agent ?? {}).providerOptions as unknown as (ctx: {
			runId: string
		}) => Record<string, any>

		expect(generalProviderOptions({ runId: 'general' }).openai.reasoningEffort).toBe('low')
		expect(outlineProviderOptions({ runId: 'outline' }).openai.reasoningEffort).toBe('high')
	})

	test('uses an alternate research model at xhigh without changing root or other child options', async () => {
		const rootModel = createMockModel('gpt-5.6-sol', 'codex')
		const researchModel = createMockModel('gpt-5.6-terra', 'codex')
		const agent = await createCodelayerAgent({
			model: rootModel,
			researchModel,
			cwd: '/tmp',
			context7ApiKey: 'context7-test-key',
			providerOptionOverrides: {
				codex: {
					reasoningEffort: 'high',
					reasoningSummary: 'detailed',
					fastMode: true,
					promptCacheKey: 'session-research-test',
				},
			},
		})
		const rootConfig = getAgentConfig(agent)
		const rootOptions = (rootConfig.providerOptions as unknown as (ctx: { runId: string }) => Record<string, any>)({
			runId: 'root',
		})
		const subagents = getSubagents(rootConfig.tools?.agent)
		const researchNames = [
			'rpi:codebase-locator',
			'rpi:codebase-analyzer',
			'rpi:codebase-pattern-finder',
			'web-search-researcher',
		]

		expect(rootConfig.model).toBe(rootModel)
		expect(rootOptions.openai).toMatchObject({
			reasoningEffort: 'high',
			fastMode: true,
			promptCacheKey: 'session-research-test',
		})

		for (const subagent of subagents) {
			const config = getAgentConfig(subagent.agent)
			const options = (config.providerOptions as unknown as (ctx: { runId: string }) => Record<string, any>)({
				runId: subagent.name,
			})
			if (researchNames.includes(subagent.name)) {
				expect(config.model, subagent.name).toBe(researchModel)
				expect(options.openai, subagent.name).toMatchObject({
					reasoningEffort: 'xhigh',
					fastMode: true,
					promptCacheKey: 'session-research-test',
				})
			} else {
				expect(config.model, subagent.name).toBe(rootModel)
				expect(options.openai.reasoningEffort, subagent.name).toBe(
					subagent.name === 'rpi:outline-implementer-agent' ? 'high' : 'low',
				)
				expect(options.openai.fastMode, subagent.name).toBe(true)
				expect(options.openai.promptCacheKey, subagent.name).toBe('session-research-test')
			}
		}
	})

	test('lets the outline implementer use parent anthropic effort while other sub-agents stay throttled', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-opus-4-8'),
			cwd: '/tmp',
			providerOptionOverrides: {
				anthropic: {
					effort: 'max',
				},
			},
		})
		const subagentTool = getAgentConfig(agent).tools?.agent
		const subagents = getSubagents(subagentTool)
		const generalPurpose = subagents.find((candidate) => candidate.name === 'general-purpose')
		const outlineImplementer = subagents.find((candidate) => candidate.name === 'rpi:outline-implementer-agent')

		const generalProviderOptions = getAgentConfig(generalPurpose?.agent ?? {}).providerOptions as unknown as (ctx: {
			runId: string
		}) => Record<string, any>
		const outlineProviderOptions = getAgentConfig(outlineImplementer?.agent ?? {}).providerOptions as unknown as (ctx: {
			runId: string
		}) => Record<string, any>

		expect(generalProviderOptions({ runId: 'general' }).anthropic.effort).toBe('low')
		expect(outlineProviderOptions({ runId: 'outline' }).anthropic.effort).toBe('max')
	})
})

describe('--subagent-thinking CLI knob', () => {
	// Capture the options passed to createCodelayerAgent. The mocked agent returns
	// immediately and process.exit throws a caught sentinel so the action settles
	// deterministically. Every spy handle is restored in a finally so it can never
	// leak the createCodelayerAgent mock into other suites under CI ordering.
	const STOP_AT_EXIT = new Error('__stop_at_exit__')

	async function captureCliAgentOptions(argv: string[], model: LanguageModel): Promise<Record<string, unknown> | undefined> {
		let captured: Record<string, unknown> | undefined
		const spies = [
			spyOn(providersModule, 'resolveModel').mockResolvedValue(model),
			spyOn(providersModule, 'resolveExaApiKey').mockReturnValue(undefined),
			spyOn(skillToolModule, 'createSkillToolFromRepoDirs').mockResolvedValue(undefined as any),
			spyOn(process, 'exit').mockImplementation(((() => {
				throw STOP_AT_EXIT
			}) as unknown) as never),
			spyOn(agentModule, 'createCodelayerAgent').mockImplementation(async (options: any) => {
				captured = options
				const run = (async function* () {})() as AsyncGenerator<never> & { result: Promise<any> }
				run.result = Promise.resolve({ finishReason: 'stop', state: { messages: [] } })
				return { run: () => run } as any
			}),
		]
		try {
			await createCodelayerCommand().parseAsync(argv)
		} catch (error) {
			if (error !== STOP_AT_EXIT) throw error
		} finally {
			for (const spy of spies) spy.mockRestore()
		}
		return captured
	}

	test('registers the --subagent-thinking option defaulting to low', () => {
		const command = createCodelayerCommand()
		const option = command.options.find((opt) => opt.long === '--subagent-thinking')

		expect(option).toBeDefined()
		expect(option?.defaultValue).toBe('low')
	})

	test('threads the default low subagent thinking into createCodelayerAgent', async () => {
		const captured = await captureCliAgentOptions(
			['node', 'codelayer', '--provider', 'codex', '--prompt', 'hi'],
			createMockModel('gpt-5.5'),
		)

		expect(captured).toMatchObject({ subagentThinking: 'low' })
	})

	test('threads an explicit valid subagent thinking value into createCodelayerAgent', async () => {
		const captured = await captureCliAgentOptions(
			['node', 'codelayer', '--provider', 'codex', '--subagent-thinking', 'high', '--prompt', 'hi'],
			createMockModel('gpt-5.5'),
		)

		expect(captured).toMatchObject({ subagentThinking: 'high' })
	})

	test('rejects a subagent thinking value outside the per-model allow-list', async () => {
		await expect(
			captureCliAgentOptions(
				['node', 'codelayer', '--provider', 'codex', '--subagent-thinking', 'extreme', '--prompt', 'hi'],
				createMockModel('gpt-5.5'),
			),
		).rejects.toThrow('Unsupported --thinking value "extreme"')
	})
})

describe('createCodingSubagentTool', () => {
	test('always exposes fork, specialist, and resume through the root agent tool', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
		})
		const tool = getAgentConfig(agent).tools?.agent as Tool<any, any> | undefined

		expect(tool?.input.safeParse({ prompt: 'inherit and inspect' }).success).toBe(true)
		expect(tool?.description).toContain('fork all eligible calling-agent conversation')
	})

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

	test('uses bash instead of dedicated search tools for research subagents', async () => {
		const tool = await createCodingSubagentTool({
			cwd: '/tmp',
			model: createMockModel('claude-sonnet-4-5'),
		})
		const subagents = getSubagents(tool)

		for (const name of [
			'rpi:codebase-locator',
			'rpi:codebase-analyzer',
			'rpi:codebase-pattern-finder',
			'web-search-researcher',
		]) {
			const subagent = subagents.find((candidate) => candidate.name === name)
			const tools = getAgentConfig(subagent?.agent ?? {}).tools

			expect(tools?.bash).toBeDefined()
			expect(tools?.read).toBeDefined()
			expect(tools?.glob).toBeUndefined()
			expect(tools?.grep).toBeUndefined()
			expect(tools?.list).toBeUndefined()
		}
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

describe('createCodelayerAgent shellEnv passthrough', () => {
	const ctx = { signal: new AbortController().signal } as any
	const SHELL_ENV = { CODELAYER_SHELL_ENV_TEST: 'threaded' }

	function bashSees(tool: unknown): Promise<string> {
		return (tool as Tool<any, any>).execute(
			{ command: 'echo "$CODELAYER_SHELL_ENV_TEST"', timeout: 5_000 },
			ctx,
		)
	}

	test('threads shellEnv into the top-level claude bash tool', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
			shellEnv: SHELL_ENV,
		})
		expect(await bashSees(getAgentConfig(agent).tools?.bash)).toContain('threaded')
	})

	test('threads shellEnv into the top-level codex bash tool', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('gpt-4.1'),
			cwd: '/tmp',
			shellEnv: SHELL_ENV,
		})
		expect(await bashSees(getAgentConfig(agent).tools?.bash)).toContain('threaded')
	})

	test('threads shellEnv into every bash-bearing subagent', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
			shellEnv: SHELL_ENV,
		})
		const subagents = getSubagents(getAgentConfig(agent).tools?.agent)
		const withBash = subagents.filter((sub) => getAgentConfig(sub.agent).tools?.bash)

		// bash specialist + general-purpose + implementer + outline-implementer all carry bash.
		expect(withBash.length).toBeGreaterThanOrEqual(3)
		for (const sub of withBash) {
			expect(await bashSees(getAgentConfig(sub.agent).tools?.bash), `subagent "${sub.name}"`).toContain('threaded')
		}
	})

	test('leaves bash env untouched when shellEnv is omitted (back-compat)', async () => {
		const agent = await createCodelayerAgent({
			model: createMockModel('claude-sonnet-4-5'),
			cwd: '/tmp',
		})
		const output = await (getAgentConfig(agent).tools?.bash as Tool<any, any>).execute(
			{ command: 'echo "[$CODELAYER_SHELL_ENV_TEST]"', timeout: 5_000 },
			ctx,
		)
		expect(output).toContain('[]')
	})
})
