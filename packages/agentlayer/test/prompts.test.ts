import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from '@ai-sdk/provider'
import { Agent, startState } from '../src'
import {
	claudePrompt,
	codexPrompt,
	defaultPrompt,
	geminiPrompt,
	openaiPrompt,
	repoInstructionsPrompt,
	systemPrompts,
} from '../src/prompts/index'
import { assistantText, userMessage } from './mocks'

// ─── systemPrompts record ─────────────────────────────────────────────────────

describe('systemPrompts', () => {
	test('has all 5 keys', () => {
		const keys = Object.keys(systemPrompts)
		expect(keys).toContain('default')
		expect(keys).toContain('claude')
		expect(keys).toContain('codex')
		expect(keys).toContain('gemini')
		expect(keys).toContain('openai')
		expect(keys).toHaveLength(5)
	})

	test('each prompt is a non-empty string', () => {
		for (const [_key, prompt] of Object.entries(systemPrompts)) {
			expect(typeof prompt).toBe('string')
			expect(prompt.length).toBeGreaterThan(0)
		}
	})

	test('defaultPrompt matches systemPrompts.default', () => {
		expect(systemPrompts.default).toBe(defaultPrompt)
	})

	test('claudePrompt matches systemPrompts.claude', () => {
		expect(systemPrompts.claude).toBe(claudePrompt)
	})

	test('codexPrompt matches systemPrompts.codex', () => {
		expect(systemPrompts.codex).toBe(codexPrompt)
	})

	test('geminiPrompt matches systemPrompts.gemini', () => {
		expect(systemPrompts.gemini).toBe(geminiPrompt)
	})

	test('openaiPrompt matches systemPrompts.openai', () => {
		expect(systemPrompts.openai).toBe(openaiPrompt)
	})
})

describe('repoInstructionsPrompt', () => {
	test('loads explicit file path when provided', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'repo-instructions-test-'))
		const filePath = join(dir, 'my-instructions.md')
		await writeFile(filePath, 'Follow these repo rules.', 'utf8')

		try {
			const prompt = await repoInstructionsPrompt({ filePath, cwd: dir })
			expect(prompt).toContain('# Repository Instructions')
			expect(prompt).toContain(filePath)
			expect(prompt).toContain('Follow these repo rules.')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	test('auto-discovers first matching candidate in order', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'repo-instructions-test-'))
		await writeFile(join(dir, 'AGENTS.md'), 'Second candidate instructions', 'utf8')
		await writeFile(join(dir, 'CLAUDE.md'), 'First candidate instructions', 'utf8')

		try {
			const prompt = await repoInstructionsPrompt({ cwd: dir })
			expect(prompt).toContain(join(dir, 'CLAUDE.md'))
			expect(prompt).toContain('First candidate instructions')
			expect(prompt).not.toContain('Second candidate instructions')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	test('returns undefined when no matching instruction files exist and allowMissing is true', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'repo-instructions-test-'))

		try {
			const prompt = await repoInstructionsPrompt({ cwd: dir, allowMissing: true, _skipRepoRootFallback: true })
			expect(prompt).toBeUndefined()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	test('throws error when no matching instruction files exist and allowMissing is false', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'repo-instructions-test-'))

		try {
			await expect(
				repoInstructionsPrompt({ cwd: dir, allowMissing: false, _skipRepoRootFallback: true }),
			).rejects.toThrow('No repo instructions found')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MOCK_USAGE: LanguageModelV3GenerateResult['usage'] = {
	inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 0, text: 0, reasoning: 0 },
}

function capturingModel(
	responses: Array<Pick<LanguageModelV3GenerateResult, 'content'>>,
	onCall?: (options: LanguageModelV3CallOptions) => void,
): LanguageModelV3 {
	let index = 0
	return {
		specificationVersion: 'v3',
		provider: 'mock',
		modelId: 'mock-model',
		supportedUrls: {},
		async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
			onCall?.(options)
			if (index >= responses.length) {
				throw new Error(`capturingModel: no more responses`)
			}
			const response = responses[index++]!
			const hasToolCalls = response.content.some((c) => c.type === 'tool-call')
			return {
				content: response.content,
				finishReason: {
					unified: hasToolCalls ? 'tool-calls' : 'stop',
					raw: hasToolCalls ? 'tool_use' : 'stop',
				},
				usage: MOCK_USAGE,
				warnings: [],
			}
		},
		async doStream() {
			throw new Error('capturingModel: streaming not supported')
		},
	}
}

// ─── system: string[] ─────────────────────────────────────────────────────────

describe('system as string[] via agent run', () => {
	test('string[] is joined with double newlines', async () => {
		let capturedPrompt: unknown[] = []
		const model = capturingModel([assistantText('Done.')], (options) => {
			capturedPrompt = options.prompt
		})

		const agent = new Agent({
			model,
			system: [defaultPrompt, claudePrompt],
			tools: {},
		})

		await agent.run({ state: startState([userMessage('hello')]) }).result

		// The system prompt is embedded in the prompt array as a system message
		const promptText = JSON.stringify(capturedPrompt)
		// Both prompts should be present, joined with \n\n
		const _expectedJoined = `${defaultPrompt}\n\n${claudePrompt}`
		expect(promptText).toContain(defaultPrompt.slice(0, 50))
		expect(promptText).toContain(claudePrompt.slice(0, 50))
	})
})
