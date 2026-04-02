/**
 * Integration tests for real AI providers.
 *
 * These run only when the corresponding API key is set in the environment.
 * To run: ANTHROPIC_API_KEY=sk-... bun test test/providers.test.ts
 *
 * Each provider is tested with the same basic scenario: a simple bash tool call
 * that the model should be able to handle, plus a stop condition that limits scope.
 */
import { describe, expect, test } from 'bun:test'
import { anthropic } from '@ai-sdk/anthropic'
import { google } from '@ai-sdk/google'
import { openai } from '@ai-sdk/openai'
import { Bash } from 'just-bash'
import { z } from 'zod'
import { Agent, defineTool, maxSteps, startState, toolCompleted } from '../src'
import { createJustBashTool } from '../src/tools/just-bash/index'

const TIMEOUT = 30_000

const doneTool = defineTool({
	name: 'done',
	description: 'Call this tool when you are finished with the task. Do not call any other tools after this.',
	input: z.object({
		summary: z.string().describe('A brief summary of what you did'),
	}),
	execute: async (input) => `Task complete: ${input.summary}`,
})

function createTestAgent(model: Parameters<typeof Agent.prototype.run>[0] extends never ? never : any) {
	const bash = new Bash({
		files: {
			'/project/hello.txt': 'Hello from the integration test!',
			'/project/package.json': '{"name": "test-project", "version": "1.0.0"}',
		},
		cwd: '/project',
	})

	return new Agent({
		model,
		system: 'You are a helpful assistant. Use the bash tool to complete tasks, then call the done tool when finished. Be concise.',
		tools: {
			bash: createJustBashTool(bash),
			done: doneTool,
		},
		stopWhen: [maxSteps(5), toolCompleted('done')],
	})
}

describe.concurrent('providers', () => {
	describe.skipIf(!process.env.ANTHROPIC_API_KEY).concurrent('anthropic (claude)', () => {
		test(
			'agent can call bash tool and complete',
			async () => {
				const agent = createTestAgent(anthropic('claude-haiku-4-5-20251001'))

				const result = await agent.run({
					state: startState([
						{
							role: 'user',
							content: 'Read the file /project/hello.txt and tell me what it says, then call done.',
						},
					]),
				}).result

				expect(result.finishReason).toBe('stopCondition')
				expect(result.stopCondition).toBeDefined()
				expect(result.newMessages.length).toBeGreaterThan(0)
			},
			TIMEOUT,
		)
	})

	describe.skipIf(!process.env.OPENAI_API_KEY).concurrent('openai (gpt)', () => {
		test(
			'agent can call bash tool and complete',
			async () => {
				const agent = createTestAgent(openai.chat('gpt-4o-mini'))

				const result = await agent.run({
					state: startState([
						{
							role: 'user',
							content: 'Read the file /project/hello.txt and tell me what it says, then call done.',
						},
					]),
				}).result

				expect(result.finishReason).toBe('stopCondition')
				expect(result.stopCondition).toBeDefined()
				expect(result.newMessages.length).toBeGreaterThan(0)
			},
			TIMEOUT,
		)
	})

	describe.skipIf(!process.env.GOOGLE_GENERATIVE_AI_API_KEY).concurrent('google (gemini)', () => {
		test(
			'agent can call bash tool and complete',
			async () => {
				const agent = createTestAgent(google('gemini-2.0-flash'))

				const result = await agent.run({
					state: startState([
						{
							role: 'user',
							content: 'Read the file /project/hello.txt and tell me what it says, then call done.',
						},
					]),
				}).result

				expect(result.finishReason).toBe('stopCondition')
				expect(result.stopCondition).toBeDefined()
				expect(result.newMessages.length).toBeGreaterThan(0)
			},
			TIMEOUT,
		)
	})
})
