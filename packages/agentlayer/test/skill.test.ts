import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from '@ai-sdk/provider'
import type { ModelMessage } from 'ai'
import { Agent, startState } from '../src'
import { createSkillTool } from '../src/tools/interfaces/skill'
import { createSkillToolFromDirs } from '../src/tools/server/skill'
import { assistantText, assistantWithToolCall, makeToolContext, userMessage } from './mocks'

// ─── Shared helpers ────────────────────────────────────────────────────────────

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

// ─── createSkillTool ──────────────────────────────────────────────────────────

describe('createSkillTool', () => {
	test('injects content as user message via updateContextWindow', async () => {
		const skills = [
			{
				name: 'greet',
				description: 'A greeting skill',
				content: 'Always say hello warmly.',
			},
		]

		const skillTool = createSkillTool({ skills })

		// Capture messages passed to second model call
		let secondCallMessages: ModelMessage[] = []
		let callCount = 0
		const model = capturingModel(
			[assistantWithToolCall('skill', { name: 'greet' }), assistantText('Done.')],
			(options) => {
				callCount++
				if (callCount === 2) {
					secondCallMessages = options.prompt as ModelMessage[]
				}
			},
		)

		const agent = new Agent({
			model,
			tools: { skill: skillTool },
		})

		await agent.run({ state: startState([userMessage('activate greet skill')]) }).result

		// Find the tool result message (role: 'tool')
		const toolResultIdx = secondCallMessages.findIndex((m) => m.role === 'tool')
		// Find the injected user message with <skill> tags
		const injectedIdx = secondCallMessages.findIndex(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes('<skill name=\\"greet\\">'),
		)

		expect(toolResultIdx).toBeGreaterThan(-1)
		expect(injectedIdx).toBeGreaterThan(-1)
		// Injected message must come AFTER the tool result
		expect(injectedIdx).toBeGreaterThan(toolResultIdx)
		// Injected message should be the last message
		expect(injectedIdx).toBe(secondCallMessages.length - 1)
		// Verify skill content is present
		const injectedMsg = secondCallMessages[injectedIdx]!
		expect(JSON.stringify(injectedMsg.content)).toContain('Always say hello warmly.')
	})

	test('skill content wrapped in <skill> tags with name attribute', async () => {
		const skills = [
			{
				name: 'test-skill',
				description: 'Test skill',
				content: 'Test content here.',
			},
		]

		const skillTool = createSkillTool({ skills })
		let capturedMessages: ModelMessage[] = []
		let callCount = 0
		const model = capturingModel(
			[assistantWithToolCall('skill', { name: 'test-skill' }), assistantText('Done.')],
			(options) => {
				callCount++
				if (callCount === 2) {
					capturedMessages = options.prompt as ModelMessage[]
				}
			},
		)

		const agent = new Agent({ model, tools: { skill: skillTool } })
		await agent.run({ state: startState([userMessage('go')]) }).result

		const injectedMsg = capturedMessages.find(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes('<skill'),
		)
		expect(injectedMsg).toBeDefined()
		const contentStr = JSON.stringify(injectedMsg!.content)
		expect(contentStr).toContain('<skill name=\\"test-skill\\">')
		expect(contentStr).toContain('Test content here.')
		expect(contentStr).toContain('</skill>')
	})

	test('skill tool with args includes args attribute in <skill> tag', async () => {
		const skills = [
			{
				name: 'parameterized',
				description: 'A parameterized skill',
				content: 'Use the args.',
			},
		]

		const skillTool = createSkillTool({ skills })
		let capturedMessages: ModelMessage[] = []
		let callCount = 0
		const model = capturingModel(
			[assistantWithToolCall('skill', { name: 'parameterized', args: 'some-arg' }), assistantText('Done.')],
			(options) => {
				callCount++
				if (callCount === 2) {
					capturedMessages = options.prompt as ModelMessage[]
				}
			},
		)

		const agent = new Agent({ model, tools: { skill: skillTool } })
		await agent.run({ state: startState([userMessage('go')]) }).result

		const injectedMsg = capturedMessages.find(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes('args='),
		)
		expect(injectedMsg).toBeDefined()
		expect(JSON.stringify(injectedMsg!.content)).toContain('args=\\"some-arg\\"')
	})

	test('returns error for unknown skill and lists available skills', async () => {
		const skills = [
			{ name: 'alpha', description: 'Alpha skill', content: 'Alpha content' },
			{ name: 'beta', description: 'Beta skill', content: 'Beta content' },
		]

		const skillTool = createSkillTool({ skills })

		// Directly execute the tool to check error output
		const toolResult = await skillTool.execute({ name: 'nonexistent' }, makeToolContext())

		const output = typeof toolResult === 'string' ? toolResult : toolResult.output
		expect(output).toContain('Error: Skill "nonexistent" not found')
		expect(output).toContain('alpha')
		expect(output).toContain('beta')
	})

	test('description is dynamically set based on available skills', () => {
		const skills = [
			{ name: 'foo', description: 'Foo skill', content: 'Foo content' },
			{ name: 'bar', description: 'Bar skill', content: 'Bar content' },
		]
		const skillTool = createSkillTool({ skills })
		expect(skillTool.description).toContain('foo')
		expect(skillTool.description).toContain('bar')
		expect(skillTool.description).toContain('Foo skill')
		expect(skillTool.description).toContain('Bar skill')
	})
})

// ─── createSkillTool — direct execution ───────────────────────────────────────

describe('createSkillTool direct execution', () => {
	test('successful activation returns correct message', async () => {
		const skills = [{ name: 'my-skill', description: 'My skill', content: 'Do something.' }]
		const skillTool = createSkillTool({ skills })
		const pendingUpdates: Array<(msgs: ModelMessage[]) => ModelMessage[]> = []

		const output = await skillTool.execute(
			{ name: 'my-skill' },
			makeToolContext({ updateContextWindow: (cb) => pendingUpdates.push(cb) }),
		)

		const text = typeof output === 'string' ? output : output.output
		expect(text).toContain('my-skill')
		expect(text).toContain('activated successfully')
		expect(pendingUpdates).toHaveLength(1)

		// Apply the pending update to verify it inserts the right content
		const before: ModelMessage[] = [{ role: 'user', content: 'some prior msg' }]
		const after = pendingUpdates[0]!(before)
		expect(after).toHaveLength(2)
		const injected = after[1]!
		expect(injected.role).toBe('user')
		expect(JSON.stringify(injected.content)).toContain('<skill name=\\"my-skill\\">')
		expect(JSON.stringify(injected.content)).toContain('Do something.')
	})
})

// ─── createSkillToolFromDirs ──────────────────────────────────────────────────

describe('createSkillToolFromDirs', () => {
	test('reads .md files from a temp directory', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'skill-test-'))
		try {
			await writeFile(join(dir, 'my-skill.md'), '# My Skill\n\nThis is my skill content.')
			await writeFile(join(dir, 'another.md'), '# Another\n\nAnother skill.')

			const skillTool = await createSkillToolFromDirs({ dirs: dir })

			// The tool should have both skills in description
			expect(skillTool.description).toContain('my-skill')
			expect(skillTool.description).toContain('another')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('skills with frontmatter description: are parsed correctly', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'skill-test-'))
		try {
			const content = `---\ndescription: My frontmatter description\n---\n\n# Heading\n\nContent here.`
			await writeFile(join(dir, 'fm-skill.md'), content)

			const skillTool = await createSkillToolFromDirs({ dirs: dir })

			// The description from frontmatter should be used, not the heading
			expect(skillTool.description).toContain('My frontmatter description')
			expect(skillTool.description).not.toContain('Heading')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('skills with # Heading (no frontmatter) use heading as description', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'skill-test-'))
		try {
			await writeFile(join(dir, 'heading-skill.md'), '# My Heading Description\n\nContent.')

			const skillTool = await createSkillToolFromDirs({ dirs: dir })

			expect(skillTool.description).toContain('My Heading Description')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('skills without frontmatter or heading use filename as description', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'skill-test-'))
		try {
			await writeFile(join(dir, 'plain-skill.md'), 'Just some plain content with no heading.')

			const skillTool = await createSkillToolFromDirs({ dirs: dir })

			// Name should be used as fallback description
			expect(skillTool.description).toContain('plain-skill')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('inline skills override directory skills with same name', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'skill-test-'))
		try {
			await writeFile(join(dir, 'overridden.md'), '# Directory version\n\nOriginal content.')

			const inlineSkill = {
				name: 'overridden',
				description: 'Inline override description',
				content: 'Overriding content.',
			}

			const skillTool = await createSkillToolFromDirs({
				dirs: dir,
				skills: [inlineSkill],
			})

			// Execute and verify inline content is used
			const pendingUpdates: Array<(msgs: ModelMessage[]) => ModelMessage[]> = []
			await skillTool.execute(
				{ name: 'overridden' },
				makeToolContext({ updateContextWindow: (cb) => pendingUpdates.push(cb) }),
			)

			expect(pendingUpdates).toHaveLength(1)
			const after = pendingUpdates[0]!([])
			const injectedContent = JSON.stringify(after[0]!.content)
			expect(injectedContent).toContain('Overriding content.')
			expect(injectedContent).not.toContain('Original content.')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('silently skips missing directories', async () => {
		// Should not throw even when directory does not exist
		const skillTool = await createSkillToolFromDirs({
			dirs: ['/nonexistent-dir-that-does-not-exist', '/another-nonexistent'],
		})
		// With no skills, still produces a valid tool
		expect(skillTool.name).toBe('skill')
	})

	test('skills from .md files are accessible and inject content correctly', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'skill-test-'))
		try {
			await writeFile(join(dir, 'code-review.md'), '# Code Review\n\nReview code carefully.')

			const skillTool = await createSkillToolFromDirs({ dirs: dir })
			const pendingUpdates: Array<(msgs: ModelMessage[]) => ModelMessage[]> = []

			const output = await skillTool.execute(
				{ name: 'code-review' },
				makeToolContext({ updateContextWindow: (cb) => pendingUpdates.push(cb) }),
			)

			const text = typeof output === 'string' ? output : output.output
			expect(text).toContain('code-review')
			expect(text).toContain('activated successfully')
			expect(pendingUpdates).toHaveLength(1)

			const after = pendingUpdates[0]!([])
			const injected = JSON.stringify(after[0]!.content)
			expect(injected).toContain('Review code carefully.')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('reads SKILL.md from subdirectories (Claude Code convention)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'skill-test-'))
		try {
			await mkdir(join(dir, 'my-skill'))
			await writeFile(join(dir, 'my-skill', 'SKILL.md'), '# My Skill\n\nSubdir skill content.')
			await mkdir(join(dir, 'another-skill'))
			await writeFile(
				join(dir, 'another-skill', 'SKILL.md'),
				'---\ndescription: Another one\n---\n\nAnother content.',
			)

			const skillTool = await createSkillToolFromDirs({ dirs: dir })

			expect(skillTool.description).toContain('my-skill')
			expect(skillTool.description).toContain('another-skill')

			const pendingUpdates: Array<(msgs: ModelMessage[]) => ModelMessage[]> = []
			await skillTool.execute(
				{ name: 'my-skill' },
				makeToolContext({ updateContextWindow: (cb) => pendingUpdates.push(cb) }),
			)

			expect(pendingUpdates).toHaveLength(1)
			const after = pendingUpdates[0]!([])
			expect(JSON.stringify(after[0]!.content)).toContain('Subdir skill content.')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('non-.md files are ignored', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'skill-test-'))
		try {
			await writeFile(join(dir, 'valid-skill.md'), '# Valid\n\nContent.')
			await writeFile(join(dir, 'ignored.txt'), 'This should be ignored.')
			await writeFile(join(dir, 'also-ignored.json'), '{"key": "value"}')

			const skillTool = await createSkillToolFromDirs({ dirs: dir })

			// Only valid-skill should appear
			expect(skillTool.description).toContain('valid-skill')
			expect(skillTool.description).not.toContain('ignored.txt')
			expect(skillTool.description).not.toContain('also-ignored')
		} finally {
			await rm(dir, { recursive: true })
		}
	})
})
