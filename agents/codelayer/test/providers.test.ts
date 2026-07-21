import { describe, expect, mock, test } from 'bun:test'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import {
	createCustomCodexResponsesModel,
	readCodexResponsesOverride,
	type CodexResponsesOverride,
} from '../src/providers'

const TEST_KEY = 'phase-one-test-key'

function override(values: Partial<CodexResponsesOverride> = {}): CodexResponsesOverride {
	return {
		baseURL: 'https://example.test/openai/v1',
		endpointURL: 'https://example.test/openai/v1/responses',
		apiKey: TEST_KEY,
		...values,
	}
}

async function captureGenerateRequest(options: {
	override?: Partial<CodexResponsesOverride>
	selectedModelId?: string
	abortSignal?: AbortSignal
} = {}) {
	const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = []
	const fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ input, init })
		return new Response(JSON.stringify({ error: { message: 'captured request' } }), {
			status: 400,
			headers: { 'content-type': 'application/json' },
		})
	})
	const model = createCustomCodexResponsesModel({
		override: override(options.override),
		selectedModelId: options.selectedModelId ?? 'gpt-5.6-sol',
		fetch,
	}) as LanguageModelV3

	try {
		await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
			abortSignal: options.abortSignal,
		})
	} catch {
		// The fake endpoint returns 400 after the request has been captured.
	}

	expect(requests).toHaveLength(1)
	return { model, request: requests[0]! }
}

function errorMessage(run: () => unknown): string {
	try {
		run()
		throw new Error('Expected function to throw')
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
}

describe('readCodexResponsesOverride', () => {
	test('returns no override when both required settings are absent', () => {
		expect(readCodexResponsesOverride({})).toBeUndefined()
		expect(readCodexResponsesOverride({ CODELAYER_CODEX_MODEL: 'wire-model' })).toBeUndefined()
	})

	test('rejects either partial setup and names only the missing setting', () => {
		const missingKey = errorMessage(() =>
			readCodexResponsesOverride({
				CODELAYER_CODEX_BASE_URL: 'https://example.test/openai/v1?secret=url-secret',
			}),
		)
		expect(missingKey).toContain('CODELAYER_CODEX_API_KEY')
		expect(missingKey).not.toContain('url-secret')

		const missingURL = errorMessage(() =>
			readCodexResponsesOverride({ CODELAYER_CODEX_API_KEY: TEST_KEY }),
		)
		expect(missingURL).toContain('CODELAYER_CODEX_BASE_URL')
		expect(missingURL).not.toContain(TEST_KEY)
	})

	test('normalizes API bases, full endpoints, and trailing slashes', () => {
		for (const baseURL of [
			'https://example.test/openai/v1',
			'https://example.test/openai/v1/',
			'https://example.test/openai/v1/responses',
			'https://example.test/openai/v1/responses/',
		]) {
			const result = readCodexResponsesOverride({
				CODELAYER_CODEX_BASE_URL: baseURL,
				CODELAYER_CODEX_API_KEY: TEST_KEY,
			})

			expect(result?.baseURL).toBe('https://example.test/openai/v1')
			expect(result?.endpointURL).toBe('https://example.test/openai/v1/responses')
		}
	})

	test('allows HTTP on loopback hosts', () => {
		for (const baseURL of [
			'http://localhost:8000/v1',
			'http://api.localhost:8000/v1',
			'http://127.20.30.40:8000/v1',
			'http://[::1]:8000/v1',
		]) {
			expect(
				readCodexResponsesOverride({
					CODELAYER_CODEX_BASE_URL: baseURL,
					CODELAYER_CODEX_API_KEY: TEST_KEY,
				}),
			).toBeDefined()
		}
	})

	test('rejects remote HTTP without including the URL or key', () => {
		const message = errorMessage(() =>
			readCodexResponsesOverride({
				CODELAYER_CODEX_BASE_URL: 'http://example.test/openai/v1?token=url-query-secret',
				CODELAYER_CODEX_API_KEY: TEST_KEY,
			}),
		)

		expect(message).toContain('CODELAYER_CODEX_BASE_URL')
		expect(message).not.toContain('example.test')
		expect(message).not.toContain('url-query-secret')
		expect(message).not.toContain(TEST_KEY)
	})

	test('rejects URL credentials without including auth values or query text', () => {
		const message = errorMessage(() =>
			readCodexResponsesOverride({
				CODELAYER_CODEX_BASE_URL:
					'https://url-user:url-password@example.test/openai/v1?token=url-query-secret',
				CODELAYER_CODEX_API_KEY: TEST_KEY,
			}),
		)

		expect(message).toContain('CODELAYER_CODEX_BASE_URL')
		for (const secret of ['url-user', 'url-password', 'url-query-secret', TEST_KEY]) {
			expect(message).not.toContain(secret)
		}
	})

	test('rejects query strings and invalid header names without exposing values', () => {
		const queryMessage = errorMessage(() =>
			readCodexResponsesOverride({
				CODELAYER_CODEX_BASE_URL: 'https://example.test/openai/v1?token=url-query-secret',
				CODELAYER_CODEX_API_KEY: TEST_KEY,
			}),
		)
		expect(queryMessage).toContain('CODELAYER_CODEX_BASE_URL')
		expect(queryMessage).not.toContain('url-query-secret')
		expect(queryMessage).not.toContain(TEST_KEY)

		const headerMessage = errorMessage(() =>
			readCodexResponsesOverride({
				CODELAYER_CODEX_BASE_URL: 'https://example.test/openai/v1',
				CODELAYER_CODEX_API_KEY: TEST_KEY,
				CODELAYER_CODEX_API_KEY_HEADER: 'invalid header',
			}),
		)
		expect(headerMessage).toContain('CODELAYER_CODEX_API_KEY_HEADER')
		expect(headerMessage).not.toContain(TEST_KEY)
	})

	test('keeps custom header and wire model values', () => {
		expect(
			readCodexResponsesOverride({
				CODELAYER_CODEX_BASE_URL: 'https://example.test/openai/v1',
				CODELAYER_CODEX_API_KEY: TEST_KEY,
				CODELAYER_CODEX_API_KEY_HEADER: 'api-key',
				CODELAYER_CODEX_MODEL: 'azure-coding-deployment',
			}),
		).toMatchObject({
			apiKeyHeader: 'api-key',
			wireModelId: 'azure-coding-deployment',
		})
	})
})

describe('createCustomCodexResponsesModel', () => {
	test('uses bearer auth and the selected model by default', async () => {
		const { model, request } = await captureGenerateRequest()
		const headers = new Headers(request.init?.headers)
		const body = JSON.parse(request.init?.body as string)

		expect(request.input.toString()).toBe('https://example.test/openai/v1/responses')
		expect(headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`)
		expect(headers.has('api-key')).toBe(false)
		expect(body.model).toBe('gpt-5.6-sol')
		expect(model.provider).toBe('custom-openai-responses')
		expect(model.modelId).toBe('gpt-5.6-sol')
	})

	test('sends a custom raw key header without an authorization header', async () => {
		const { request } = await captureGenerateRequest({ override: { apiKeyHeader: 'api-key' } })
		const headers = new Headers(request.init?.headers)

		expect(headers.get('api-key')).toBe(TEST_KEY)
		expect(headers.has('authorization')).toBe(false)
		expect([...headers.values()].filter((value) => value.includes(TEST_KEY))).toEqual([TEST_KEY])
	})

	test('preserves fetch input and request fields while replacing auth', async () => {
		const controller = new AbortController()
		const { request } = await captureGenerateRequest({
			override: { apiKeyHeader: 'x-api-key' },
			abortSignal: controller.signal,
		})

		expect(request.input.toString()).toBe('https://example.test/openai/v1/responses')
		expect(request.init?.method).toBe('POST')
		expect(request.init?.body).toBeString()
		expect(request.init?.signal).toBe(controller.signal)
	})

	test('sends the wire model while exposing the selected model identity', async () => {
		const { model, request } = await captureGenerateRequest({
			override: { wireModelId: 'azure-coding-deployment' },
			selectedModelId: 'gpt-5.6-sol',
		})
		const body = JSON.parse(request.init?.body as string)

		expect(body.model).toBe('azure-coding-deployment')
		expect(model.provider).toBe('custom-openai-responses')
		expect(model.modelId).toBe('gpt-5.6-sol')
		expect(model.doGenerate).toBeFunction()
		expect(model.doStream).toBeFunction()
	})

	test('delegates doGenerate and doStream through the wrapped language model', () => {
		const model = createCustomCodexResponsesModel({
			override: override(),
			selectedModelId: 'gpt-5.6-sol',
			fetch: mock(async () => new Response()),
		}) as LanguageModelV3

		expect(model.specificationVersion).toBe('v3')
		expect(model.supportedUrls).toBeDefined()
	})
})
