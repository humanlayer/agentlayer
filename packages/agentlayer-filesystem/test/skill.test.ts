import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamPart,
	LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import { Agent, createSkillTool, startState } from '@humanlayer/agentlayer-core'
import type { ModelMessage } from 'ai'
import { simulateReadableStream } from 'ai/test'
import { createSkillToolFromDirs } from '../src/tools'
import { assistantText, assistantWithToolCall, makeToolContext, userMessage } from './mocks'

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
				throw new Error('capturingModel: no more responses')
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
		async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
			onCall?.(options)
			if (index >= responses.length) {
				throw new Error('capturingModel: no more responses')
			}
			const response = responses[index++]!
			const hasToolCalls = response.content.some((c) => c.type === 'tool-call')
			const contentChunks: LanguageModelV3StreamPart[] = []
			for (const part of response.content) {
				if (part.type === 'text') {
					const id = crypto.randomUUID()
					contentChunks.push(
						{ type: 'text-start', id },
						{ type: 'text-delta', id, delta: part.text },
						{ type: 'text-end', id },
					)
					continue
				}

				if (
					part.type === 'tool-call' ||
					part.type === 'tool-result' ||
					part.type === 'source' ||
					part.type === 'file'
				) {
					contentChunks.push(part)
				}
			}

			return {
				stream: simulateReadableStream<LanguageModelV3StreamPart>({
					chunks: [
						{ type: 'stream-start', warnings: [] },
						...contentChunks,
						{
							type: 'finish',
							finishReason: {
								unified: hasToolCalls ? 'tool-calls' : 'stop',
								raw: hasToolCalls ? 'tool_use' : 'stop',
							},
							usage: MOCK_USAGE,
						},
					],
					initialDelayInMs: null,
					chunkDelayInMs: null,
				}),
			}
		},
	}
}

describe('createSkillTool', () => {
	test('injects content as a user message via updateContextWindow', async () => {
		const skills = [
			{
				name: 'greet',
				description: 'A greeting skill',
				content: 'Always say hello warmly.',
			},
		]

		const skillTool = createSkillTool({ skills })
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

		const agent = new Agent({ model, tools: { skill: skillTool } })
		await agent.run({ state: startState([userMessage('activate greet skill')]) }).result

		const toolResultIdx = secondCallMessages.findIndex((m) => m.role === 'tool')
		const injectedIdx = secondCallMessages.findIndex(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes('<skill name=\\"greet\\">'),
		)

		expect(toolResultIdx).toBeGreaterThan(-1)
		expect(injectedIdx).toBeGreaterThan(toolResultIdx)
		expect(injectedIdx).toBe(secondCallMessages.length - 1)
	})
})

describe('createSkillToolFromDirs', () => {
	test('SKILL.md convention sets baseDir to the skill directory', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'skill-test-'))
		try {
			await mkdir(join(dir, 'my-skill'))
			await writeFile(join(dir, 'my-skill', 'SKILL.md'), '# My Skill\n\nSubdir skill content.')

			const skillTool = await createSkillToolFromDirs({ dirs: dir })
			const pendingUpdates: Array<(msgs: ModelMessage[]) => ModelMessage[]> = []
			await skillTool.execute(
				{ name: 'my-skill' },
				makeToolContext({ updateContextWindow: (cb) => pendingUpdates.push(cb) }),
			)

			const after = pendingUpdates[0]!([])
			expect(JSON.stringify(after[0]!.content)).toContain(join(dir, 'my-skill'))
		} finally {
			await rm(dir, { recursive: true })
		}
	})
})
