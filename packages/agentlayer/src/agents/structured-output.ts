import process from 'node:process'
import { anthropic } from '@ai-sdk/anthropic'
import type { UserModelMessage } from 'ai'
import { z } from 'zod'
import { Agent, structuredOutputCalled } from '../core'
import { defaultPrompt, environmentPrompt, structuredOutputPrompt } from '../prompts'
import { structuredOutput } from '../tools'

/**
 * Helper to create a user message.
 */
function userMessage(content: string): UserModelMessage {
	return { role: 'user', content }
}

const companySchema = z.object({
	name: z.string(),
	founded: z.number(),
	headquarters: z.string(),
	products: z.array(z.string()),
	summary: z.string().describe('A one-sentence summary of the company'),
})

const { tool, parse } = structuredOutput(companySchema)

const agent = new Agent({
	model: anthropic('claude-sonnet-4-20250514'),
	tools: {
		structured_output: tool,
	},
	stopWhen: structuredOutputCalled(),
	system: [defaultPrompt, environmentPrompt({ cwd: process.cwd() }), structuredOutputPrompt],
})

console.log('Running structured output example...\n')

const result = await agent.run({
	state: {
		messages: [userMessage('Tell me about Anthropic as a company.')],
	},
}).result

console.log('Finish reason:', result.finishReason)

const data = parse(result)
if (data) {
	console.log('\nStructured output:')
	console.log(JSON.stringify(data, null, 4))
} else {
	console.log('\nNo structured output produced.')
	console.log('New messages:', JSON.stringify(result.newMessages, null, 2))
}
