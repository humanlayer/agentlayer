/**
 * Tests for preRequest hooks — ctx.next() and ctx.transform()
 *
 * Validates that:
 * - ctx.next() passes messages through to the model unchanged
 * - ctx.transform(messages) changes what the model sees but NOT the actual context window
 * - ctx.transform(messages, { persist: true }) changes both the model view AND the context window
 * - View-only transforms are truly ephemeral across multiple model calls
 * - Multiple hooks compose — each sees the previous hook's transform
 * - Persist OR-aggregation — any persist=true makes the final result persistent
 * - No hooks configured works as a zero-cost passthrough
 */

import { describe, expect, test } from 'bun:test'
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import { simulateReadableStream } from 'ai/test'
import { z } from 'zod'
import type { PreRequestHook } from '../src'
import { Agent, createPreRequestHook, defineTool, startState } from '../src'
import { PRIVATE_CODEX_API_CONTEXT_WINDOW_SIZE_LIMIT } from '../src/models'
import { assistantText, assistantWithToolCall, mockModel, userMessage } from './mocks'

// ── Spy model helper ──────────────────────────────────────────────────────────

interface SpyModel {
	model: LanguageModelV3
	/** The prompt (messages) received on each doGenerate call, in order. */
	calls: LanguageModelV3CallOptions['prompt'][]
}

/**
 * Wraps a mockModel to capture the prompt (messages) it receives on each call.
 */
function spyModel(responses: Parameters<typeof mockModel>[0]): SpyModel {
	const inner = mockModel(responses)
	const calls: LanguageModelV3CallOptions['prompt'][] = []
	const model: LanguageModelV3 = {
		...inner,
		async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
			calls.push(structuredClone(options.prompt))
			return inner.doGenerate(options)
		},
		async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
			calls.push(structuredClone(options.prompt))
			const result = await inner.doStream(options)
			return {
				...result,
				stream: simulateReadableStream({
					chunks: await Array.fromAsync(result.stream),
					initialDelayInMs: null,
					chunkDelayInMs: null,
				}),
			}
		},
	}
	return { model, calls }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const echoTool = defineTool({
	name: 'echo',
	description: 'Echoes input',
	input: z.object({ text: z.string() }),
	output: z.string(),
	execute: async (input) => input.text,
})

/**
 * Check whether any prompt part in a call contains a given string.
 */
function promptContains(prompt: LanguageModelV3CallOptions['prompt'], needle: string): boolean {
	return prompt.some((part) => JSON.stringify(part).includes(needle))
}

describe('preRequest — ctx.next()', () => {
	test('no-op passthrough: messages are sent to model unchanged', async () => {
		const hook: PreRequestHook = (ctx) => ctx.next()

		const spy = spyModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')])

		const agent = new Agent({
			model: spy.model,
			tools: { echo: echoTool },
			hooks: { preRequest: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')

		// First model call should have received the original user message
		expect(spy.calls.length).toBeGreaterThanOrEqual(1)
		expect(promptContains(spy.calls[0]!, 'go')).toBe(true)
	})

	test('tool receives correct input and agent completes normally', async () => {
		let receivedInput: Record<string, unknown> | null = null

		const captureTool = defineTool({
			name: 'capture',
			description: 'Captures input',
			input: z.object({ value: z.string() }),
			output: z.string(),
			execute: async (input) => {
				receivedInput = input
				return input.value
			},
		})

		const hook: PreRequestHook = (ctx) => ctx.next()

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('capture', { value: 'test-value' }), assistantText('Done.')]),
			tools: { capture: captureTool },
			hooks: { preRequest: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')
		expect(receivedInput).toBeDefined()
		expect((receivedInput as any)?.value).toBe('test-value')
	})
})

describe('preRequest — ctx.transform(messages) view-only', () => {
	test('model receives transformed messages', async () => {
		// Start with two user messages; the hook replaces the first one's content
		const hook: PreRequestHook = (ctx) => {
			const transformed = ctx.messages.map((m) => {
				if (m.role === 'user' && JSON.stringify(m.content).includes('secret')) {
					return { ...m, content: 'redacted' } as typeof m
				}
				return m
			})
			return ctx.transform([...transformed])
		}

		const spy = spyModel([assistantText('Done.')])

		const agent = new Agent({
			model: spy.model,
			tools: { echo: echoTool },
			hooks: { preRequest: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('secret message')]) }).result

		expect(result.finishReason).toBe('complete')

		// The model should have received 'redacted' instead of 'secret message'
		expect(promptContains(spy.calls[0]!, 'secret message')).toBe(false)
		expect(promptContains(spy.calls[0]!, 'redacted')).toBe(true)
	})

	test('actual context window is NOT mutated — original messages still in result.state.messages', async () => {
		// Hook replaces user message content with "redacted" (view-only, no persist)
		const hook: PreRequestHook = (ctx) => {
			const transformed = ctx.messages.map((m) => {
				if (m.role === 'user' && JSON.stringify(m.content).includes('important context')) {
					return { ...m, content: 'redacted' } as typeof m
				}
				return m
			})
			return ctx.transform([...transformed])
		}

		const spy = spyModel([assistantText('Done.')])

		const agent = new Agent({
			model: spy.model,
			tools: { echo: echoTool },
			hooks: { preRequest: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('important context')]) }).result

		expect(result.finishReason).toBe('complete')

		// The original user message should STILL be in the final state messages (not mutated)
		const hasOriginalMsg = result.state.messages.some(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes('important context'),
		)
		expect(hasOriginalMsg).toBe(true)

		// The redacted version should NOT be in state
		const hasRedacted = result.state.messages.some(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes('redacted'),
		)
		expect(hasRedacted).toBe(false)

		// But the model DID see the redacted version, not the original
		expect(promptContains(spy.calls[0]!, 'important context')).toBe(false)
		expect(promptContains(spy.calls[0]!, 'redacted')).toBe(true)
	})
})

describe('preRequest — ctx.transform(messages, { persist: true })', () => {
	test('model receives transformed messages', async () => {
		// Hook replaces user message content and persists the change
		const hook: PreRequestHook = (ctx) => {
			const transformed = ctx.messages.map((m) => {
				if (m.role === 'user' && JSON.stringify(m.content).includes('to be replaced')) {
					return { ...m, content: 'replaced-content' } as typeof m
				}
				return m
			})
			return ctx.transform([...transformed], { persist: true })
		}

		const spy = spyModel([assistantText('Done.')])

		const agent = new Agent({
			model: spy.model,
			tools: { echo: echoTool },
			hooks: { preRequest: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('to be replaced')]) }).result

		expect(result.finishReason).toBe('complete')

		// Model should have seen the replacement
		expect(promptContains(spy.calls[0]!, 'to be replaced')).toBe(false)
		expect(promptContains(spy.calls[0]!, 'replaced-content')).toBe(true)
	})

	test('actual context window IS mutated — original messages NOT in result.state.messages', async () => {
		// Hook replaces user message content and persists
		const hook: PreRequestHook = (ctx) => {
			const transformed = ctx.messages.map((m) => {
				if (m.role === 'user' && JSON.stringify(m.content).includes('original-value')) {
					return { ...m, content: 'persisted-replacement' } as typeof m
				}
				return m
			})
			return ctx.transform([...transformed], { persist: true })
		}

		const spy = spyModel([assistantText('Done.')])

		const agent = new Agent({
			model: spy.model,
			tools: { echo: echoTool },
			hooks: { preRequest: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('original-value')]) }).result

		expect(result.finishReason).toBe('complete')

		// The original user message should NOT be in the final state (it was persisted away)
		const hasOriginal = result.state.messages.some(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes('original-value'),
		)
		expect(hasOriginal).toBe(false)

		// The replacement SHOULD be in the final state
		const hasReplacement = result.state.messages.some(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes('persisted-replacement'),
		)
		expect(hasReplacement).toBe(true)
	})
})

describe('preRequest — transform without persist is ephemeral across steps', () => {
	test('removed message reappears on second model call', async () => {
		let callCount = 0

		// Hook that redacts user messages on the FIRST call only
		const hook: PreRequestHook = (ctx) => {
			callCount++
			if (callCount === 1) {
				// First call: redact user messages (no persist)
				const transformed = ctx.messages.map((m) => {
					if (m.role === 'user') {
						return { ...m, content: 'redacted-ephemeral' } as typeof m
					}
					return m
				})
				return ctx.transform([...transformed])
			}
			// Second call: pass through
			return ctx.next()
		}

		const spy = spyModel([
			// Step 1: model calls a tool
			assistantWithToolCall('echo', { text: 'step1' }),
			// Step 2: model completes
			assistantText('All done.'),
		])

		const agent = new Agent({
			model: spy.model,
			tools: { echo: echoTool },
			hooks: { preRequest: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('persistent user msg')]) }).result

		expect(result.finishReason).toBe('complete')
		expect(spy.calls.length).toBe(2)

		// First call: should see 'redacted-ephemeral' NOT the original
		expect(promptContains(spy.calls[0]!, 'persistent user msg')).toBe(false)
		expect(promptContains(spy.calls[0]!, 'redacted-ephemeral')).toBe(true)

		// Second call: should see the ORIGINAL (transform was ephemeral, not persisted)
		expect(promptContains(spy.calls[1]!, 'persistent user msg')).toBe(true)
	})

	test('always-on transform without persist: state preserves original across steps', async () => {
		// Hook always adds a system message, but never persists
		const hook: PreRequestHook = (ctx) => {
			const systemMsg = { role: 'system' as const, content: 'ephemeral-injected-system-msg' }
			return ctx.transform([systemMsg, ...ctx.messages])
		}

		const spy = spyModel([assistantWithToolCall('echo', { text: 'a' }), assistantText('Final.')])

		const agent = new Agent({
			model: spy.model,
			tools: { echo: echoTool },
			hooks: { preRequest: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('always present')]) }).result

		expect(result.finishReason).toBe('complete')
		expect(spy.calls.length).toBe(2)

		// Both calls should see the injected system message
		for (const call of spy.calls) {
			expect(promptContains(call, 'ephemeral-injected-system-msg')).toBe(true)
		}

		// The user message should be in the final state (never removed)
		const hasOriginal = result.state.messages.some(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes('always present'),
		)
		expect(hasOriginal).toBe(true)

		// The injected system message should NOT be in state (not persisted)
		const hasInjected = result.state.messages.some(
			(m) => m.role === 'system' && JSON.stringify(m.content).includes('ephemeral-injected-system-msg'),
		)
		expect(hasInjected).toBe(false)
	})
})

describe('preRequest — multiple hooks compose', () => {
	test('each hook sees the previous transform result', async () => {
		const systemMsg = { role: 'system' as const, content: 'injected-by-hook-1' }

		// Hook 1: adds a system message
		const hook1: PreRequestHook = (ctx) => {
			return ctx.transform([systemMsg, ...ctx.messages])
		}

		// Hook 2: verifies it sees hook 1's system message, then adds a marker
		let hook2SawSystemMsg = false
		const hook2: PreRequestHook = (ctx) => {
			hook2SawSystemMsg = ctx.messages.some(
				(m) => m.role === 'system' && JSON.stringify(m.content).includes('injected-by-hook-1'),
			)
			// Add another message
			const extraMsg = { role: 'system' as const, content: 'injected-by-hook-2' }
			return ctx.transform([...ctx.messages, extraMsg])
		}

		const spy = spyModel([assistantText('Done.')])

		const agent = new Agent({
			model: spy.model,
			tools: { echo: echoTool },
			hooks: { preRequest: [hook1, hook2] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')

		// Hook 2 should have seen hook 1's system message
		expect(hook2SawSystemMsg).toBe(true)

		// The model should have received both injected system messages
		const prompt = spy.calls[0]!
		expect(promptContains(prompt, 'injected-by-hook-1')).toBe(true)
		expect(promptContains(prompt, 'injected-by-hook-2')).toBe(true)
	})
})

describe('preRequest — persist OR-aggregation', () => {
	test('any persist=true makes the final result persistent', async () => {
		// Hook 1: transform WITHOUT persist — replaces user message content
		const hook1: PreRequestHook = (ctx) => {
			const transformed = ctx.messages.map((m) => {
				if (m.role === 'user' && JSON.stringify(m.content).includes('should-be-replaced')) {
					return { ...m, content: 'hook1-replacement' } as typeof m
				}
				return m
			})
			return ctx.transform([...transformed])
		}

		// Hook 2: transform WITH persist — passes through (no further changes)
		const hook2: PreRequestHook = (ctx) => {
			return ctx.transform([...ctx.messages], { persist: true })
		}

		const spy = spyModel([assistantText('Done.')])

		const agent = new Agent({
			model: spy.model,
			tools: { echo: echoTool },
			hooks: { preRequest: [hook1, hook2] },
		})

		const result = await agent.run({ state: startState([userMessage('should-be-replaced')]) }).result

		expect(result.finishReason).toBe('complete')

		// Because hook2 set persist=true, hook1's replacement should be persisted to state
		// The original should NOT be in state
		const hasOriginal = result.state.messages.some(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes('should-be-replaced'),
		)
		expect(hasOriginal).toBe(false)

		// The replacement SHOULD be in state
		const hasReplacement = result.state.messages.some(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes('hook1-replacement'),
		)
		expect(hasReplacement).toBe(true)
	})

	test('all persist=false means transform is NOT persisted', async () => {
		// Hook 1: transform without persist — replaces content
		const hook1: PreRequestHook = (ctx) => {
			const transformed = ctx.messages.map((m) => {
				if (m.role === 'user') {
					return { ...m, content: 'hook1-view-only' } as typeof m
				}
				return m
			})
			return ctx.transform([...transformed])
		}

		// Hook 2: also transform without persist
		const hook2: PreRequestHook = (ctx) => {
			return ctx.transform([...ctx.messages])
		}

		const spy = spyModel([assistantText('Done.')])

		const agent = new Agent({
			model: spy.model,
			tools: { echo: echoTool },
			hooks: { preRequest: [hook1, hook2] },
		})

		const result = await agent.run({ state: startState([userMessage('should survive')]) }).result

		expect(result.finishReason).toBe('complete')

		// Neither hook set persist, so the original user message should still be in state
		const hasOriginal = result.state.messages.some(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes('should survive'),
		)
		expect(hasOriginal).toBe(true)
	})
})

describe('preRequest — createPreRequestHook factory', () => {
	test('factory-created hook transforms messages', async () => {
		const hook = createPreRequestHook((ctx) => {
			const transformed = ctx.messages.map((m) => {
				if (m.role === 'user' && JSON.stringify(m.content).includes('factory-test')) {
					return { ...m, content: 'factory-transformed' } as typeof m
				}
				return m
			})
			return ctx.transform([...transformed])
		})

		const spy = spyModel([assistantText('Done.')])

		const agent = new Agent({
			model: spy.model,
			tools: { echo: echoTool },
			hooks: { preRequest: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('factory-test')]) }).result

		expect(result.finishReason).toBe('complete')
		expect(promptContains(spy.calls[0]!, 'factory-test')).toBe(false)
		expect(promptContains(spy.calls[0]!, 'factory-transformed')).toBe(true)
	})

	test('factory-created hook composes with manually typed hooks', async () => {
		const factoryHook = createPreRequestHook((ctx) => {
			const systemMsg = { role: 'system' as const, content: 'from-factory' }
			return ctx.transform([systemMsg, ...ctx.messages])
		})

		const manualHook: PreRequestHook = (ctx) => {
			const systemMsg = { role: 'system' as const, content: 'from-manual' }
			return ctx.transform([...ctx.messages, systemMsg])
		}

		const spy = spyModel([assistantText('Done.')])

		const agent = new Agent({
			model: spy.model,
			tools: { echo: echoTool },
			hooks: { preRequest: [factoryHook, manualHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')
		expect(promptContains(spy.calls[0]!, 'from-factory')).toBe(true)
		expect(promptContains(spy.calls[0]!, 'from-manual')).toBe(true)
	})

	test('factory-created async hook works', async () => {
		const hook = createPreRequestHook(async (ctx) => {
			await Promise.resolve()
			return ctx.next()
		})

		const spy = spyModel([assistantText('Done.')])

		const agent = new Agent({
			model: spy.model,
			tools: { echo: echoTool },
			hooks: { preRequest: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('async-test')]) }).result

		expect(result.finishReason).toBe('complete')
		expect(promptContains(spy.calls[0]!, 'async-test')).toBe(true)
	})
})

describe('preRequest — token context', () => {
	const mockUsage = (input: number, output: number) => ({
		inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: output, text: output, reasoning: 0 },
	})

	test('hook receives contextWindowTokens from previous streamText call', async () => {
		const capturedTokens: number[] = []

		const hook = createPreRequestHook((ctx) => {
			capturedTokens.push(ctx.contextWindowTokens)
			return ctx.next()
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('echo', { text: 'a' }, { usage: mockUsage(800, 200) }),
				assistantText('Done.', { usage: mockUsage(1200, 100) }),
			]),
			tools: { echo: echoTool },
			hooks: { preRequest: [hook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		// First call: 0 tokens (no streamText yet)
		expect(capturedTokens[0]).toBe(0)
		// Second call: 800 + 200 = 1000 from first streamText
		expect(capturedTokens[1]).toBe(1000)
	})

	test('hook receives contextWindowLimit from agent config', async () => {
		let capturedLimit: number | undefined

		const hook = createPreRequestHook((ctx) => {
			capturedLimit = ctx.contextWindowLimit
			return ctx.next()
		})

		const agent = new Agent({
			model: mockModel([assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preRequest: [hook] },
			contextWindowLimit: 200_000,
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(capturedLimit).toBe(200_000)
	})

	test('hook receives resolved Codex contextWindowLimit when not configured', async () => {
		let capturedLimit: number | undefined

		const hook = createPreRequestHook((ctx) => {
			capturedLimit = ctx.contextWindowLimit
			return ctx.next()
		})

		const agent = new Agent({
			model: {
				...mockModel([assistantText('Done.')]),
				provider: 'codex.responses',
				modelId: 'gpt-5.5',
			},
			tools: { echo: echoTool },
			hooks: { preRequest: [hook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(capturedLimit).toBe(PRIVATE_CODEX_API_CONTEXT_WINDOW_SIZE_LIMIT)
	})

	test('contextWindowLimit is undefined when not configured', async () => {
		let capturedLimit: number | undefined = 999 // sentinel

		const hook = createPreRequestHook((ctx) => {
			capturedLimit = ctx.contextWindowLimit
			return ctx.next()
		})

		const agent = new Agent({
			model: mockModel([assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preRequest: [hook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(capturedLimit).toBeUndefined()
	})
})

describe('preRequest — no hooks configured', () => {
	test('agent works normally without preRequest hooks', async () => {
		let receivedInput: Record<string, unknown> | null = null

		const captureTool = defineTool({
			name: 'capture',
			description: 'Captures input',
			input: z.object({ value: z.string() }),
			output: z.string(),
			execute: async (input) => {
				receivedInput = input
				return input.value
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('capture', { value: 'no-hooks' }), assistantText('Done.')]),
			tools: { capture: captureTool },
			// No hooks at all
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')
		expect(receivedInput).toBeDefined()
		expect((receivedInput as any)?.value).toBe('no-hooks')

		// All messages should be present in state
		const hasUserMsg = result.state.messages.some(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes('go'),
		)
		expect(hasUserMsg).toBe(true)
	})

	test('agent works normally with empty preRequest array', async () => {
		const spy = spyModel([assistantText('Done.')])

		const agent = new Agent({
			model: spy.model,
			tools: { echo: echoTool },
			hooks: { preRequest: [] },
		})

		const result = await agent.run({ state: startState([userMessage('hello')]) }).result

		expect(result.finishReason).toBe('complete')

		// Model should have received the original message
		expect(promptContains(spy.calls[0]!, 'hello')).toBe(true)
	})
})
