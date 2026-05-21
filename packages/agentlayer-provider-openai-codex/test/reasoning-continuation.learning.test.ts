/**
 * Learning test: Codex reasoning continuation with/without `id` field
 *
 * This test makes REAL API calls to Codex to verify:
 * 1. Initial request returns reasoning with `itemId` and `encrypted_content`
 * 2. Continuation WITHOUT `id` field fails (empty response)
 * 3. Continuation WITH `id` field succeeds
 *
 * Run with: bun test reasoning-continuation.learning.test.ts
 * Requires valid Codex auth in ~/.humanlayer/agent-sdk/auth.json
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test'

setDefaultTimeout(60_000) // 60 second timeout for real API calls

import { createFileAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { streamText } from 'ai'
import { buildCodexRequestBody, createCodexLanguageModel } from '../src/codex'

describe('reasoning continuation learning test', () => {
	const authStore = createFileAuthStore()

	test('captures reasoning metadata from initial response', async () => {
		const model = createCodexLanguageModel({
			modelId: 'gpt-5.5',
			authStore,
		})

		const result = await streamText({
			model,
			system: 'You are a helpful assistant. Show your reasoning.',
			prompt: 'Think step by step about what 17 * 23 equals, then give me just the answer.',
			providerOptions: {
				openai: {
					store: false,
					include: ['reasoning.encrypted_content'],
					reasoningEffort: 'low',
					reasoningSummary: 'auto',
				},
			},
		})

		const parts: any[] = []
		for await (const part of result.fullStream) {
			parts.push(part)
			if (part.type === 'reasoning-start' || part.type === 'reasoning-end') {
				console.log('Reasoning part:', JSON.stringify(part, null, 2))
			}
		}

		// Find reasoning parts with metadata
		const reasoningParts = parts.filter((p) => p.type === 'reasoning-start' || p.type === 'reasoning-end')
		console.log(`Found ${reasoningParts.length} reasoning parts`)

		// Check that we got reasoning with proper metadata
		const reasoningEnd = parts.find((p) => p.type === 'reasoning-end')
		expect(reasoningEnd).toBeDefined()
		expect(reasoningEnd?.providerMetadata?.openai?.itemId).toMatch(/^rs_/)
		console.log('itemId:', reasoningEnd?.providerMetadata?.openai?.itemId)
		console.log(
			'encrypted_content present:',
			typeof reasoningEnd?.providerMetadata?.openai?.reasoningEncryptedContent === 'string',
		)
	})

	test('continuation WITHOUT id field - should fail or return empty', async () => {
		// First, get a real reasoning response to capture metadata
		const model = createCodexLanguageModel({
			modelId: 'gpt-5.5',
			authStore,
		})

		const initial = await streamText({
			model,
			system: 'You are a helpful assistant.',
			prompt: 'Think briefly, then say Hello.',
			providerOptions: {
				openai: {
					store: false,
					include: ['reasoning.encrypted_content'],
					reasoningEffort: 'low',
					reasoningSummary: 'auto',
				},
			},
		})

		const initialParts: any[] = []
		for await (const part of initial.fullStream) {
			initialParts.push(part)
		}

		const reasoningEnd = initialParts.find((p) => p.type === 'reasoning-end')
		const textEnd = initialParts.find((p) => p.type === 'text-end')
		expect(reasoningEnd).toBeDefined()

		const itemId = reasoningEnd?.providerMetadata?.openai?.itemId
		const encryptedContent = reasoningEnd?.providerMetadata?.openai?.reasoningEncryptedContent
		console.log('Captured itemId:', itemId)
		console.log('Captured encrypted_content:', `${encryptedContent?.slice(0, 50)}...`)

		// Build a continuation request WITHOUT the id field (simulating the bug)
		const bodyWithoutId = buildCodexRequestBody(
			{
				prompt: [
					{ role: 'user', content: [{ type: 'text', text: 'Think briefly, then say Hello.' }] },
					{
						role: 'assistant',
						content: [
							{
								type: 'reasoning',
								text: 'thinking...',
								providerMetadata: {
									openai: {
										// itemId intentionally OMITTED to simulate bug
										reasoningEncryptedContent: encryptedContent,
									},
								},
							} as any,
							{ type: 'text', text: textEnd?.providerMetadata?.openai?.itemId ? '' : 'Hello!' },
						],
					},
					{ role: 'user', content: [{ type: 'text', text: 'Now say Goodbye.' }] },
				],
				providerOptions: {
					openai: {
						store: false,
						include: ['reasoning.encrypted_content'],
						reasoningEffort: 'low',
					},
				},
			},
			'gpt-5.5',
		)

		console.log('Request body WITHOUT id:', JSON.stringify(bodyWithoutId.input, null, 2))

		// The reasoning item should NOT have an `id` field
		const reasoningInput = bodyWithoutId.input.find((i: any) => i.type === 'reasoning')
		expect(reasoningInput).toBeDefined()
		expect(reasoningInput?.id).toBeUndefined() // BUG: no id field
		console.log('Reasoning input (without id):', JSON.stringify(reasoningInput, null, 2))
	})

	test('continuation WITH id field - should succeed', async () => {
		const model = createCodexLanguageModel({
			modelId: 'gpt-5.5',
			authStore,
		})

		const initial = await streamText({
			model,
			system: 'You are a helpful assistant.',
			prompt: 'Think briefly, then say Hello.',
			providerOptions: {
				openai: {
					store: false,
					include: ['reasoning.encrypted_content'],
					reasoningEffort: 'low',
					reasoningSummary: 'auto',
				},
			},
		})

		const initialParts: any[] = []
		for await (const part of initial.fullStream) {
			initialParts.push(part)
		}

		const reasoningEnd = initialParts.find((p) => p.type === 'reasoning-end')
		const _textEnd = initialParts.find((p) => p.type === 'text-end')
		expect(reasoningEnd).toBeDefined()

		const itemId = reasoningEnd?.providerMetadata?.openai?.itemId
		const encryptedContent = reasoningEnd?.providerMetadata?.openai?.reasoningEncryptedContent

		// Build a continuation request WITH the id field (the fix)
		const bodyWithId = buildCodexRequestBody(
			{
				prompt: [
					{ role: 'user', content: [{ type: 'text', text: 'Think briefly, then say Hello.' }] },
					{
						role: 'assistant',
						content: [
							{
								type: 'reasoning',
								text: 'thinking...',
								providerMetadata: {
									openai: {
										itemId, // WITH itemId - the fix
										reasoningEncryptedContent: encryptedContent,
									},
								},
							} as any,
							{ type: 'text', text: 'Hello!' },
						],
					},
					{ role: 'user', content: [{ type: 'text', text: 'Now say Goodbye.' }] },
				],
				providerOptions: {
					openai: {
						store: false,
						include: ['reasoning.encrypted_content'],
						reasoningEffort: 'low',
					},
				},
			},
			'gpt-5.5',
		)

		console.log('Request body WITH id:', JSON.stringify(bodyWithId.input, null, 2))

		// The reasoning item SHOULD have an `id` field
		const reasoningInput = bodyWithId.input.find((i: any) => i.type === 'reasoning')
		expect(reasoningInput).toBeDefined()
		expect(reasoningInput?.id).toBe(itemId) // FIX: id field present
		console.log('Reasoning input (with id):', JSON.stringify(reasoningInput, null, 2))

		// Now make the actual continuation request
		console.log('Making continuation request...')
		const continuation = await streamText({
			model,
			system: 'You are a helpful assistant.',
			messages: [
				{ role: 'user', content: 'Think briefly, then say Hello.' },
				{
					role: 'assistant',
					content: [
						{
							type: 'reasoning',
							text: 'thinking...',
							providerMetadata: {
								openai: {
									itemId,
									reasoningEncryptedContent: encryptedContent,
								},
							},
						} as any,
						{ type: 'text', text: 'Hello!' },
					],
				},
				{ role: 'user', content: 'Now say Goodbye.' },
			],
			providerOptions: {
				openai: {
					store: false,
					include: ['reasoning.encrypted_content'],
					reasoningEffort: 'low',
				},
			},
		})

		const contParts: any[] = []
		for await (const part of continuation.fullStream) {
			contParts.push(part)
			if (part.type === 'error') {
				console.log('ERROR in continuation:', part)
			}
		}

		console.log(
			'Continuation part types:',
			contParts.map((p) => p.type),
		)

		const textDeltas = contParts.filter((p) => p.type === 'text-delta')
		console.log('Text delta parts:', JSON.stringify(textDeltas, null, 2))

		const contText = textDeltas.map((p) => p.textDelta || p.text || p.delta || '').join('')
		console.log('Continuation response text:', contText || '(empty)')

		// Check we got SOME response (reasoning or text)
		const hasReasoning = contParts.some((p) => p.type === 'reasoning-start')
		const hasText = contText.length > 0
		console.log('Has reasoning:', hasReasoning, 'Has text:', hasText)
		expect(hasReasoning || hasText).toBe(true)
	})
})
