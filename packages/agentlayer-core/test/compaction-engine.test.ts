import { describe, expect, test } from 'bun:test'
import type { ModelMessage } from 'ai'
import {
	compactionUsableTokens,
	estimateMessageTokens,
	findCompactionCut,
	hasValidToolCallResultPairs,
	isContextOverflowError,
	planCompaction,
	resolveCompactionMaxOutputTokens,
	resolveCompactionPolicy,
	resolveCompactionThreshold,
	serializeConversation,
} from '../src/compaction'
import { assistantMessage, toolCall, toolResult, userMessage } from '../src/messages'

describe('compaction policy', () => {
	test('uses Fold-compatible budget arithmetic', () => {
		expect(compactionUsableTokens({ contextWindow: 200_000 })).toBe(151_616)
		expect(compactionUsableTokens({ contextWindow: 100, reserveTokens: 50 })).toBe(63)
		expect(compactionUsableTokens({ contextWindow: 1 })).toBe(1)
	})

	test('caps history and turn-prefix summary output against reserved and model budgets', () => {
		expect(resolveCompactionMaxOutputTokens({ reserveTokens: 20_000 })).toBe(16_000)
		expect(resolveCompactionMaxOutputTokens({ reserveTokens: 20_000, turnPrefix: true })).toBe(10_000)
		expect(resolveCompactionMaxOutputTokens({ reserveTokens: 20_000, modelOutputLimit: 3_000 })).toBe(3_000)
		expect(resolveCompactionMaxOutputTokens({})).toBe(13_107)
	})

	test('is enabled by default and resolves disablement and overrides', () => {
		const defaults = resolveCompactionPolicy()
		expect(defaults).toMatchObject({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 })
		expect(resolveCompactionThreshold(defaults, 200_000)).toBe(151_616)

		const disabled = resolveCompactionPolicy({ enabled: false })
		expect(disabled.enabled).toBe(false)

		const overridden = resolveCompactionPolicy({
			thresholdTokens: 42,
			contextWindow: 1_000,
			reserveTokens: 10,
			keepRecentTokens: 25,
			compactionPrompt: 'Initial override.',
			compactionUpdatePrompt: 'Incremental override.',
		})
		expect(resolveCompactionThreshold(overridden, 200_000)).toBe(42)
		expect(overridden).toMatchObject({
			contextWindow: 1_000,
			reserveTokens: 10,
			keepRecentTokens: 25,
			compactionPrompt: 'Initial override.',
			compactionUpdatePrompt: 'Incremental override.',
		})
	})
})

describe('compaction engine', () => {
	test('estimates text with the chars/4 heuristic', () => {
		expect(estimateMessageTokens(userMessage('12345678'))).toBe(2)
		expect(estimateMessageTokens(userMessage(''))).toBe(1)
	})

	test('selects a bounded native tail at a coherent boundary', () => {
		const messages = [
			userMessage('old user'),
			assistantMessage('old assistant'),
			userMessage('new user'),
			assistantMessage('new assistant'),
		]
		const cut = findCompactionCut(messages, { keepRecentTokens: 6 })
		expect(cut).toBe(2)

		const plan = planCompaction(messages, { keepRecentTokens: 6 })
		expect(plan?.replacedMessages).toEqual(messages.slice(0, 2))
		expect(plan?.retainedMessages).toEqual(messages.slice(2))
		expect(plan?.conversationText).toContain('[User]: old user')
		expect(plan?.conversationText).toContain('[Assistant]: old assistant')
	})

	test('keeps tool results with matching calls and pending calls in the retained region', () => {
		const call = toolCall({ toolCallId: 'call-1', toolName: 'read', input: { path: 'a.ts' } })
		const result = toolResult({ toolCallId: 'call-1', toolName: 'read', output: 'contents' })
		const messages: ModelMessage[] = [
			userMessage('old'),
			assistantMessage('old answer'),
			userMessage('use a tool'),
			call,
			result,
		]

		const cut = findCompactionCut(messages, {
			keepRecentTokens: 1,
			requiredToolCallIds: new Set(['call-1']),
		})
		expect(cut).toBe(3)
		expect(hasValidToolCallResultPairs(messages.slice(cut))).toBe(true)
		expect(hasValidToolCallResultPairs([result])).toBe(false)
	})

	test('splits an oversized current turn only at message boundaries', () => {
		const call = toolCall({ toolCallId: 'call-1', toolName: 'read', input: { path: 'large.ts' } })
		const result = toolResult({ toolCallId: 'call-1', toolName: 'read', output: 'x'.repeat(400) })
		const messages: ModelMessage[] = [
			userMessage('older completed request'),
			assistantMessage('older completed answer'),
			userMessage('oversized current request'),
			assistantMessage('early progress'),
			call,
			result,
			assistantMessage('ok'),
		]
		const plan = planCompaction(messages, { keepRecentTokens: 2 })

		expect(plan?.isSplitTurn).toBe(true)
		expect(plan?.historyMessages).toEqual(messages.slice(0, 2))
		expect(plan?.turnPrefixMessages).toEqual(messages.slice(2, 6))
		expect(plan?.retainedMessages).toEqual(messages.slice(6))
		expect(plan?.replacedMessages).toEqual(messages.slice(0, 6))
		expect(hasValidToolCallResultPairs(plan!.retainedMessages)).toBe(true)
		expect(plan?.turnPrefixConversationText).toContain('[Tool result]')
	})

	test('bounds serialized tool output without dropping transcript roles', () => {
		const transcript = serializeConversation([
			userMessage('inspect'),
			toolCall({ toolCallId: 'call-1', toolName: 'bash', input: { command: 'run' } }),
			toolResult({ toolCallId: 'call-1', toolName: 'bash', output: 'x'.repeat(3_000) }),
		])
		expect(transcript).toContain('[User]: inspect')
		expect(transcript).toContain('[Assistant tool calls]: bash(')
		expect(transcript).toContain('1000 more characters truncated')
		expect(transcript.length).toBeLessThan(2_300)
	})

	test('recognizes provider overflow errors and excludes rate limits and quotas', () => {
		expect(isContextOverflowError(new Error('context_length_exceeded'))).toBe(true)
		expect(isContextOverflowError('Prompt is too long for this model')).toBe(true)
		expect(isContextOverflowError('rate limit: request exceeds the context window')).toBe(false)
		expect(isContextOverflowError('quota exceeded')).toBe(false)
		expect(isContextOverflowError('connection reset')).toBe(false)
	})
})
