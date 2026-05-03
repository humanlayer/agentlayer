import { describe, expect, test } from 'bun:test'
import type { LanguageModel } from 'ai'
import { createYjsMarkdownApplyAgent } from '../src/agent'
import { createFakeSecureApplyExecutor, secureApplyResultSchema } from '../src/secure-apply-tool'

function createMockModel(): LanguageModel {
	return {
		specificationVersion: 'v3',
		provider: 'mock',
		modelId: 'mock-apply-model',
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

describe('secure apply contract', () => {
	test('validates secure apply result shape', () => {
		const result = secureApplyResultSchema.parse({
			ok: true,
			proposedUpdateBase64: 'update',
			changedArtifacts: ['/artifacts/plan.md'],
		})

		expect(result.ok).toBe(true)
	})

	test('creates an agentlayer-core agent with the secure apply tool', () => {
		const agent = createYjsMarkdownApplyAgent({
			model: createMockModel(),
			executor: createFakeSecureApplyExecutor({ ok: true, proposedUpdateBase64: 'update' }),
		}) as unknown as { tools?: Record<string, unknown>; system?: string }

		expect(agent.tools?.secure_apply_yjs_update).toBeDefined()
		expect(agent.system).toContain('Yjs Markdown apply agent')
	})
})
