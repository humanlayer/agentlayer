/**
 * Phase 1 proof: the `LLMDiagnostics` service is wired end-to-end through the
 * Codex SSE provider. We run the *real* vendored LLMClient pipeline (not a
 * mocked LLMClient.Service) over a failing RequestExecutor so the stream
 * reaches the final `Stream.catchCause`, and assert the provider's diagnostics
 * context received the proof record with the merged annotations + transport.
 *
 * The provider builds the concrete `LLMDiagnostics` layer from
 * `providerOptions.diagnostics`; `_testLayers` supplies a real `LLMClient.layer`
 * backed by a failing executor to deterministically trigger the error site.
 */
import { describe, expect, test } from 'bun:test'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { LLMClient } from '@humanlayer/opencode-llm-vendor/route/client'
import { RequestExecutor } from '@humanlayer/opencode-llm-vendor/route/executor'
import { LLMError, TransportReason } from '@humanlayer/opencode-llm-vendor/schema'
import { Effect, Layer, Stream } from 'effect'
import { createCodexSseVendorProvider } from '../src/providers/sse-vendor-provider'
import { CODEX_PROVIDER_ID } from '../src/shared/constants'
import type { CodexDiagnosticRecord } from '../src/shared/types'

/**
 * A real `LLMClient.layer` whose RequestExecutor always fails with a retryable
 * transport error. Because `firstEventTimeoutRetries` defaults to 0 here and the
 * executor's own retries are exhausted, the failure propagates through the
 * vendored stream pipeline to the final `catchCause`.
 */
function failingClientLayer(): Layer.Layer<any> {
	const failingExecutor = Layer.succeed(
		RequestExecutor.Service,
		RequestExecutor.Service.of({
			execute: () =>
				Effect.fail(
					new LLMError({
						module: 'RequestExecutor',
						method: 'execute',
						reason: new TransportReason({ message: 'simulated transport failure', kind: 'open' }),
					}),
				),
		}),
	)
	return LLMClient.layer.pipe(Layer.provide(failingExecutor))
}

function createFailingProvider() {
	const store = createMemoryAuthStore({
		[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'test-sse-api-key' },
	})

	const records: CodexDiagnosticRecord[] = []
	const diagnostics = {
		annotations: { sessionId: 'test-session-123', model: 'gpt-5.4', provider: 'codex' },
		onEvent: (record: CodexDiagnosticRecord) => {
			records.push(record)
		},
	}

	const provider = createCodexSseVendorProvider({
		authStore: store,
		version: '1.0.0-test',
		diagnostics,
		_testLayers: failingClientLayer(),
	})

	return { provider, records }
}

async function drain(stream: ReadableStream<{ type: string }>): Promise<Array<{ type: string }>> {
	const parts: Array<{ type: string }> = []
	const reader = stream.getReader()
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			parts.push(value)
		}
	} catch {
		// The simulated transport failure rejects the reader; the diagnostic has
		// already fired in the vendored catchCause. Swallow so we can assert.
	}
	return parts
}

describe('codex provider diagnostics (Phase 1 proof site)', () => {
	test('emits codex.provider.stream.failed at the final catchCause with merged annotations', async () => {
		const { provider, records } = createFailingProvider()
		const model = provider.languageModel('gpt-5.4')

		const result = await model.doStream({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})

		// Drain the stream — the underlying transport fails, so an error part is
		// surfaced; the diagnostic fires inside the vendored catchCause.
		await drain(result.stream as ReadableStream<{ type: string }>)

		const proof = records.find((record) => record.event === 'codex.provider.stream.failed')
		expect(proof).toBeDefined()
		expect(proof!.severity).toBe('error')
		expect(proof!.transport).toBe('sse')
		expect(proof!.annotations).toMatchObject({ sessionId: 'test-session-123' })
		expect(proof!.metadata).toMatchObject({ terminal: true })
	})

	test('does not emit when no failure occurs', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'test-sse-api-key' },
		})
		const records: CodexDiagnosticRecord[] = []

		// Mock LLMClient.Service so a clean (empty) stream completes without errors.
		const cleanLayer = Layer.succeed(
			LLMClient.Service,
			LLMClient.Service.of({
				prepare: (() => Effect.succeed({})) as any,
				stream: (() => Stream.fromIterable([])) as any,
				generate: (() => Effect.succeed({ events: [], usage: undefined })) as any,
			}),
		)

		const provider = createCodexSseVendorProvider({
			authStore: store,
			version: '1.0.0-test',
			diagnostics: {
				annotations: { sessionId: 'clean-session' },
				onEvent: (record) => records.push(record),
			},
			// Provide a mock that returns an empty stream (no error path hit).
			_testLayers: cleanLayer,
		})

		const model = provider.languageModel('gpt-5.4')
		const result = await model.doStream({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})
		await drain(result.stream as ReadableStream<{ type: string }>)

		expect(records.find((record) => record.event === 'codex.provider.stream.failed')).toBeUndefined()
	})
})
