import { describe, expect, test } from 'bun:test'
import {
	buildCodingProviderOptions,
	claudePrompt,
	codexPrompt,
	defaultPrompt,
	detectModelFamily,
	geminiPrompt,
	ORCHESTRATOR_PROMPT,
	openaiPrompt,
	resolveCodingModelPrompt,
	systemPrompts,
	tarsPersona,
} from '../src/prompts'

describe('provider system prompts', () => {
	test('exports copied provider prompts', () => {
		expect(systemPrompts.default).toBe(defaultPrompt)
		expect(systemPrompts.claude).toBe(claudePrompt)
		expect(systemPrompts.codex).toBe(codexPrompt)
		expect(systemPrompts.gemini).toBe(geminiPrompt)
		expect(systemPrompts.openai).toBe(openaiPrompt)
	})

	test('resolves family prompts from model keys', () => {
		expect(resolveCodingModelPrompt('default')).toBe(defaultPrompt)
		expect(resolveCodingModelPrompt('claude')).toBe(claudePrompt)
		expect(resolveCodingModelPrompt('codex')).toBe(codexPrompt)
		expect(resolveCodingModelPrompt('gemini')).toBe(geminiPrompt)
		expect(resolveCodingModelPrompt('openai')).toBe(openaiPrompt)
	})

	test('detects model family from model ids', () => {
		expect(detectModelFamily('claude-sonnet-4-5')).toBe('claude')
		expect(detectModelFamily('gpt-5.4')).toBe('codex')
		expect(detectModelFamily('gpt-4.1')).toBe('codex')
		expect(detectModelFamily('gpt-5.3-codex')).toBe('codex')
		expect(detectModelFamily('gemini-2.5-pro')).toBe('gemini')
		expect(detectModelFamily({ provider: 'openai.responses', modelId: 'gpt-5.4' } as any)).toBe('codex')
		expect(detectModelFamily({ provider: 'openai.responses', modelId: 'gpt-4.1' } as any)).toBe('codex')
	})

	test('builds coding provider options', () => {
		const anthropic = buildCodingProviderOptions('claude-opus-4-6')
		expect(anthropic.anthropic).toEqual({
			// @ts-expect-error
			thinking: { type: 'adaptive' },
			cacheControl: { type: 'ephemeral' },
		})

		const sonnet5 = buildCodingProviderOptions('claude-sonnet-5')
		expect(sonnet5.anthropic).toEqual({
			// @ts-expect-error
			thinking: { type: 'adaptive' },
			cacheControl: { type: 'ephemeral' },
		})

		const openai = buildCodingProviderOptions('gpt-5.4')
		expect(openai.openai).toEqual({
			store: false,
			reasoningEffort: 'medium',
			reasoningSummary: 'auto',
			include: ['reasoning.encrypted_content'],
		})
	})

	test('exports tars persona factory', () => {
		expect(tarsPersona(25)).toContain('You are TARS')
	})

	test('exports orchestrator prompt', () => {
		expect(ORCHESTRATOR_PROMPT).toContain('# Sub-Agent Orchestration')
		expect(ORCHESTRATOR_PROMPT).toContain('delegate tasks with significant overlap')
	})
})
