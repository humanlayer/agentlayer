import { beforeEach, describe, expect, test } from 'bun:test'
import { Bash } from 'just-bash'
import { z } from 'zod'
import {
	Agent,
	AgentError,
	defineTool,
	InvalidMessagesError,
	maxSteps,
	startState,
	toolCalled,
	toolCompleted,
} from '../src'
import { createJustBashTool } from '../src/tools/just-bash/index'
import {
	assistantText,
	assistantWithToolCall,
	assistantWithToolCalls,
	extractToolCallId,
	getToolResults,
	mockModel,
	outputValue,
	toolResultMessage,
	userMessage,
} from './mocks'

// ─── Execution tracking ──────────────────────────────────────────────────────

let deployExecuteCount = 0
let bashExecuteCount = 0

beforeEach(() => {
	deployExecuteCount = 0
	bashExecuteCount = 0
})

const spyDeployTool = defineTool({
	name: 'deploy',
	description: 'Deploy to production',
	input: z.object({}),
	execute: async () => {
		deployExecuteCount++
		return 'Deployed.'
	},
})

// ─── toolCalled stop > resume with synthetic result ──────────────────────────

describe('toolCalled stop > resume with synthetic result', () => {
	test('run 1 stops before execution, run 2 resumes with synthetic result', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('deploy', {}),
				// Run 2: model sees approval result and wraps up
				assistantText('Deployment approved and complete.'),
			]),
			tools: {
				deploy: spyDeployTool,
			},
			stopWhen: toolCalled('deploy'),
		})

		// Run 1
		const result1 = await agent.run({ state: startState([userMessage('deploy')]) }).result
		expect(result1.finishReason).toBe('stopCondition')
		expect(result1.stopCondition!.name).toBe('toolCalled:deploy')
		expect(deployExecuteCount).toBe(0)

		// messages = [user, assistant(tool-call)]
		expect(result1.state.messages.length).toBe(2)

		// last message is assistant with tool-call content
		const lastMsg1 = result1.state.messages[result1.state.messages.length - 1]!
		expect(lastMsg1.role).toBe('assistant')
		expect(Array.isArray(lastMsg1.content)).toBe(true)
		const hasDeploy =
			Array.isArray(lastMsg1.content) &&
			lastMsg1.content.some((p) => p.type === 'tool-call' && p.toolName === 'deploy')
		expect(hasDeploy).toBe(true)

		// Run 2: pass result1.state.messages + toolResultMessage
		const toolCallId = extractToolCallId(result1.state.messages, 'deploy')
		const result2 = await agent.run({
			state: startState([
				...result1.state.messages,
				toolResultMessage(toolCallId, 'deploy', 'Approved. Proceed.'),
			]),
		}).result

		// Agent did NOT execute deploy — caller provided result
		expect(deployExecuteCount).toBe(0)
		expect(result2.finishReason).toBe('complete')

		// newMessages has exactly 1 message: [assistant]
		expect(result2.newMessages.length).toBe(1)
		expect(result2.newMessages[0]!.role).toBe('assistant')

		// last message is assistant (text, no tool calls)
		const lastMsg2 = result2.state.messages[result2.state.messages.length - 1]!
		expect(lastMsg2.role).toBe('assistant')
	})
})

// ─── toolCalled stop > resume with dangling tool call (agent executes) ───────

describe('toolCalled stop > resume with dangling tool call (agent executes)', () => {
	test('run 1 stops before execution, run 2 agent executes dangling tool then continues', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('deploy', {}),
				// Run 2: model sees preamble tool result and wraps up
				assistantText('Deployment complete.'),
			]),
			tools: {
				deploy: spyDeployTool,
			},
			stopWhen: toolCalled('deploy'),
		})

		// Run 1
		const result1 = await agent.run({ state: startState([userMessage('deploy')]) }).result
		expect(result1.finishReason).toBe('stopCondition')
		expect(deployExecuteCount).toBe(0)

		// messages ends with assistant (tool-call, no tool result)
		const lastMsg1 = result1.state.messages[result1.state.messages.length - 1]!
		expect(lastMsg1.role).toBe('assistant')

		// Run 2: pass result1.state.messages as-is (no tool result added)
		const result2 = await agent.run({ state: startState([...result1.state.messages]) }).result

		// preamble executed deploy
		expect(deployExecuteCount).toBe(1)

		// newMessages has exactly 2 messages: [tool, assistant]
		expect(result2.newMessages.length).toBe(2)
		expect(result2.newMessages[0]!.role).toBe('tool')

		// newMessages[0] contains tool-result for 'deploy' with output 'Deployed.'
		const [deployResult] = getToolResults(result2.newMessages, { toolName: 'deploy' })
		expect(deployResult).toBeDefined()
		expect(outputValue(deployResult!)).toBe('Deployed.')

		expect(result2.newMessages[1]!.role).toBe('assistant')
		expect(result2.finishReason).toBe('complete')

		// last message is assistant (text)
		const lastMsg2 = result2.state.messages[result2.state.messages.length - 1]!
		expect(lastMsg2.role).toBe('assistant')
	})
})

// ─── maxSteps stop > resume ──────────────────────────────────────────────────

describe('maxSteps stop > resume', () => {
	test('run 1 hits maxSteps, run 2 resumes from tool result without user message', async () => {
		// Track bash executions via the spy
		const spyBashTool = defineTool({
			name: 'bash',
			description: 'Run a bash command',
			input: z.object({ command: z.string() }),
			execute: async (input) => {
				bashExecuteCount++
				return `Exit code: 0\n${input.command}`
			},
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo step1' }),
				assistantWithToolCall('bash', { command: 'echo step2' }),
				// Run 2: model sees tool results and wraps up
				assistantText('Done with both steps.'),
			]),
			tools: { bash: spyBashTool },
			stopWhen: maxSteps(2),
		})

		// Run 1: hits maxSteps(2)
		const result1 = await agent.run({ state: startState([userMessage('do stuff')]) }).result
		expect(result1.finishReason).toBe('stopCondition')
		expect(result1.stopCondition!.name).toBe('maxSteps')

		// last message of result1 is tool (result)
		const lastMsg1 = result1.state.messages[result1.state.messages.length - 1]!
		expect(lastMsg1.role).toBe('tool')

		// Run 2: pass result1.state.messages directly — no user message appended
		const result2 = await agent.run({ state: startState([...result1.state.messages]) }).result
		expect(result2.finishReason).toBe('complete')

		// newMessages has exactly 1 message: [assistant]
		expect(result2.newMessages.length).toBe(1)

		// last message is assistant (text)
		const lastMsg2 = result2.state.messages[result2.state.messages.length - 1]!
		expect(lastMsg2.role).toBe('assistant')
	})
})

// ─── toolCompleted stop > resume ────────────────────────────────────────────

describe('toolCompleted stop > resume', () => {
	test('run 1 stops after done tool executes, run 2 resumes from tool result', async () => {
		const doneTool = defineTool({
			name: 'done',
			description: 'Signal completion',
			input: z.object({}),
			execute: async () => 'Done.',
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('done', {}),
				// Run 2: model sees result and wraps up
				assistantText('Task complete.'),
			]),
			tools: { done: doneTool },
			stopWhen: toolCompleted('done'),
		})

		// Run 1
		const result1 = await agent.run({ state: startState([userMessage('do stuff')]) }).result
		expect(result1.finishReason).toBe('stopCondition')
		expect(result1.stopCondition!.name).toBe('toolCompleted:done')

		// last message is tool (result for 'done')
		const lastMsg1 = result1.state.messages[result1.state.messages.length - 1]!
		expect(lastMsg1.role).toBe('tool')

		// Run 2: pass result1.state.messages directly — no user message appended
		const result2 = await agent.run({ state: startState([...result1.state.messages]) }).result
		expect(result2.finishReason).toBe('complete')

		// newMessages has exactly 1 message: [assistant]
		expect(result2.newMessages.length).toBe(1)

		// last message is assistant (text)
		const lastMsg2 = result2.state.messages[result2.state.messages.length - 1]!
		expect(lastMsg2.role).toBe('assistant')
	})
})

// ─── invalid messages > throws InvalidMessagesError ─────────────────────────

describe('invalid messages > returns error result', () => {
	test('finishes with error when last message is assistant text with no tool calls', async () => {
		const agent = new Agent({
			model: mockModel([]),
			tools: {},
		})

		const assistantTextMessage = {
			role: 'assistant' as const,
			content: [{ type: 'text' as const, text: 'Hello' }],
		}

		const result = await agent.run({ state: startState([userMessage('hi'), assistantTextMessage]) }).result

		expect(result.finishReason).toBe('error')
		expect(result.error).toBeDefined()
		expect(result.error).toBeInstanceOf(InvalidMessagesError)
		expect(result.error).toBeInstanceOf(AgentError)
		expect(result.error!.type).toBe('invalid_messages_error')
		expect(result.error!.message).toContain('assistant text')
	})
})

// ─── dangling parallel tool calls > agent executes all ───────────────────────

describe('dangling parallel tool calls > agent executes all', () => {
	test('agent executes all dangling tool calls from multi-tool step', async () => {
		const spyBashTool2 = defineTool({
			name: 'bash',
			description: 'Run bash',
			input: z.object({ command: z.string() }),
			execute: async () => {
				bashExecuteCount++
				return 'Exit code: 0'
			},
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'deploy', input: {} },
					{ toolName: 'bash', input: { command: 'echo hi' } },
				),
				// Run 2: model sees both results and wraps up
				assistantText('Both tools ran.'),
			]),
			tools: {
				deploy: spyDeployTool,
				bash: spyBashTool2,
			},
			stopWhen: toolCalled('deploy'),
		})

		// Run 1: model emits assistantWithToolCalls(deploy, bash), toolCalled stops
		const result1 = await agent.run({ state: startState([userMessage('deploy and run bash')]) }).result
		expect(result1.finishReason).toBe('stopCondition')
		expect(deployExecuteCount).toBe(0)
		expect(bashExecuteCount).toBe(0)

		// Run 2: pass result1.state.messages as-is (no results added)
		const result2 = await agent.run({ state: startState([...result1.state.messages]) }).result

		expect(deployExecuteCount).toBe(1)
		expect(bashExecuteCount).toBe(1)

		// newMessages has exactly 3 messages: [tool, tool, assistant]
		expect(result2.newMessages.length).toBe(3)
		expect(result2.newMessages[0]!.role).toBe('tool')
		expect(result2.newMessages[1]!.role).toBe('tool')
		expect(result2.newMessages[2]!.role).toBe('assistant')
		expect(result2.finishReason).toBe('complete')

		// last message is assistant (text)
		const lastMsg = result2.state.messages[result2.state.messages.length - 1]!
		expect(lastMsg.role).toBe('assistant')
	})
})

// ─── JSON serialization round-trip ──────────────────────────────────────────

describe('JSON serialization round-trip', () => {
	test('messages survive JSON.stringify > JSON.parse and resume works', async () => {
		const spyBashTool3 = defineTool({
			name: 'bash',
			description: 'Run bash',
			input: z.object({ command: z.string() }),
			execute: async () => {
				bashExecuteCount++
				return 'Exit code: 0\nhello'
			},
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo hello' }),
				// After round-trip, model continues
				assistantText('All good after round-trip.'),
			]),
			tools: { bash: spyBashTool3 },
			stopWhen: maxSteps(1),
		})

		// Run 1: maxSteps(1) stops after 1 bash step
		const result1 = await agent.run({ state: startState([userMessage('hello')]) }).result
		expect(result1.finishReason).toBe('stopCondition')

		// last message is tool (result)
		const lastMsg1 = result1.state.messages[result1.state.messages.length - 1]!
		expect(lastMsg1.role).toBe('tool')

		// Serialize and deserialize the state
		const serialized = JSON.parse(JSON.stringify(result1.state.messages))

		// Run 2: pass serialized messages directly (no user message)
		const result2 = await agent.run({ state: startState(serialized) }).result
		expect(result2.finishReason).toBe('complete')

		// newMessages has exactly 1 message: [assistant]
		expect(result2.newMessages.length).toBe(1)

		// last message is assistant (text)
		const lastMsg2 = result2.state.messages[result2.state.messages.length - 1]!
		expect(lastMsg2.role).toBe('assistant')
	})
})

// ─── chain of interruptions ──────────────────────────────────────────────────

describe('chain of interruptions', () => {
	test('3 sequential toolCalled stop > resume cycles produce correct history', async () => {
		const agent = new Agent({
			model: mockModel([
				// Run 1: model calls deploy
				assistantWithToolCall('deploy', {}),
				// Run 2: model calls deploy again
				assistantWithToolCall('deploy', {}),
				// Run 3: model calls deploy a third time
				assistantWithToolCall('deploy', {}),
				// Run 4: model wraps up
				assistantText('All three deployments done.'),
			]),
			tools: { deploy: spyDeployTool },
			stopWhen: toolCalled('deploy'),
		})

		// Run 1
		const result1 = await agent.run({ state: startState([userMessage('deploy three times')]) }).result
		expect(result1.finishReason).toBe('stopCondition')
		// [user, assistant]
		expect(result1.state.messages.length).toBe(2)
		const callId1 = extractToolCallId(result1.state.messages, 'deploy')

		// Run 2: resume with synthetic result for first deploy
		const result2 = await agent.run({
			state: startState([...result1.state.messages, toolResultMessage(callId1, 'deploy', 'Deploy 1 approved.')]),
		}).result
		expect(result2.finishReason).toBe('stopCondition')
		// [user, assistant, tool, assistant]
		expect(result2.state.messages.length).toBe(4)
		const callId2 = extractToolCallId(result2.state.messages, 'deploy')

		// Run 3: resume with synthetic result for second deploy
		const result3 = await agent.run({
			state: startState([...result2.state.messages, toolResultMessage(callId2, 'deploy', 'Deploy 2 approved.')]),
		}).result
		expect(result3.finishReason).toBe('stopCondition')
		// [user, assistant, tool, assistant, tool, assistant]
		expect(result3.state.messages.length).toBe(6)
		const callId3 = extractToolCallId(result3.state.messages, 'deploy')

		// Run 4: resume with synthetic result for third deploy > model wraps up
		const result4 = await agent.run({
			state: startState([...result3.state.messages, toolResultMessage(callId3, 'deploy', 'Deploy 3 approved.')]),
		}).result
		expect(result4.finishReason).toBe('complete')
		// [user, assistant, tool, assistant, tool, assistant, tool, assistant]
		expect(result4.state.messages.length).toBe(8)

		// Verify message roles in order
		const roles = result4.state.messages.map((m) => m.role)
		expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])

		// last message is assistant (text)
		const lastMsg = result4.state.messages[result4.state.messages.length - 1]!
		expect(lastMsg.role).toBe('assistant')

		// deployExecuteCount === 0 throughout (all synthetic results)
		expect(deployExecuteCount).toBe(0)
	})
})

// ─── Anthropic integration tests ─────────────────────────────────────────────

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('anthropic resumability', () => {
	const TIMEOUT = 30_000

	async function getAnthropicModel() {
		const { anthropic } = await import('@ai-sdk/anthropic')
		return anthropic('claude-haiku-4-5-20251001')
	}

	// Each Anthropic test gets its own local spy tool to avoid shared state
	// contamination from concurrent mock tests resetting the module-level counter.
	function makeLocalDeployTool() {
		let count = 0
		const tool = defineTool({
			name: 'deploy',
			description: 'Deploy to production',
			input: z.object({}),
			execute: async () => {
				count++
				return 'Deployed.'
			},
		})
		return { tool, getCount: () => count }
	}

	test(
		'toolCalled stop > synthetic result > model continues coherently',
		async () => {
			const model = await getAnthropicModel()
			const { tool: localDeploy, getCount } = makeLocalDeployTool()

			const agent = new Agent({
				model,
				system: 'You are a helpful assistant. When asked to deploy, use the deploy tool.',
				tools: { deploy: localDeploy },
				stopWhen: toolCalled('deploy'),
			})

			// Run 1: real model calls deploy, toolCalled stops
			const result1 = await agent.run({
				state: startState([userMessage('Please deploy the application to production.')]),
			}).result
			expect(result1.finishReason).toBe('stopCondition')
			expect(result1.stopCondition!.name).toBe('toolCalled:deploy')

			// last message is assistant with tool-call
			const lastMsg1 = result1.state.messages[result1.state.messages.length - 1]!
			expect(lastMsg1.role).toBe('assistant')
			expect(getCount()).toBe(0)

			const toolCallId = extractToolCallId(result1.state.messages, 'deploy')

			// Run 2: pass result1.state.messages + toolResultMessage
			const result2 = await agent.run({
				state: startState([
					...result1.state.messages,
					toolResultMessage(toolCallId, 'deploy', 'Deployment approved and completed successfully.'),
				]),
			}).result
			expect(result2.finishReason).toBe('complete')

			// last message of result2 is assistant
			const lastMsg2 = result2.state.messages[result2.state.messages.length - 1]!
			expect(lastMsg2.role).toBe('assistant')

			// last message has text content (not tool calls)
			const hasTextContent = Array.isArray(lastMsg2.content) && lastMsg2.content.some((p) => p.type === 'text')
			expect(hasTextContent).toBe(true)

			expect(getCount()).toBe(0)
		},
		TIMEOUT,
	)

	test(
		'toolCalled stop > dangling > agent executes > model continues',
		async () => {
			const model = await getAnthropicModel()
			const { tool: localDeploy, getCount } = makeLocalDeployTool()

			const agent = new Agent({
				model,
				system: 'You are a helpful assistant. When asked to deploy, use the deploy tool.',
				tools: { deploy: localDeploy },
				stopWhen: toolCalled('deploy'),
			})

			// Run 1: real model calls deploy, toolCalled stops
			const result1 = await agent.run({
				state: startState([userMessage('Please deploy the application.')]),
			}).result
			expect(result1.finishReason).toBe('stopCondition')
			expect(getCount()).toBe(0)

			// Run 2: pass result1.state.messages as-is (dangling)
			const result2 = await agent.run({ state: startState([...result1.state.messages]) }).result
			expect(getCount()).toBe(1) // preamble executed

			// result2.newMessages[0] is the preamble result
			expect(result2.newMessages[0]!.role).toBe('tool')
			expect(result2.finishReason).toBe('complete')

			// last message is assistant
			const lastMsg = result2.state.messages[result2.state.messages.length - 1]!
			expect(lastMsg.role).toBe('assistant')

			// last message has text content (not tool calls)
			const hasTextContent = Array.isArray(lastMsg.content) && lastMsg.content.some((p) => p.type === 'text')
			expect(hasTextContent).toBe(true)
		},
		TIMEOUT,
	)

	test(
		'maxSteps stop > resume without user message > model continues',
		async () => {
			const model = await getAnthropicModel()

			const agent = new Agent({
				model,
				system: 'You are a helpful assistant. Use bash to complete tasks.',
				tools: { bash: createJustBashTool(new Bash({ cwd: '/tmp' })) },
				stopWhen: maxSteps(1),
			})

			// Run 1: real model does 1 step, maxSteps(1) fires
			const result1 = await agent.run({
				state: startState([userMessage('Run echo hello using bash.')]),
			}).result
			expect(result1.finishReason).toBe('stopCondition')

			// last message is tool (result)
			const lastMsg1 = result1.state.messages[result1.state.messages.length - 1]!
			expect(lastMsg1.role).toBe('tool')

			// Run 2: pass result1.state.messages directly (no user message)
			const result2 = await agent.run({ state: startState([...result1.state.messages]) }).result
			expect(result2.finishReason).toBe('complete')

			// last message is assistant
			const lastMsg2 = result2.state.messages[result2.state.messages.length - 1]!
			expect(lastMsg2.role).toBe('assistant')

			// last message has text content (not tool calls)
			const hasTextContent = Array.isArray(lastMsg2.content) && lastMsg2.content.some((p) => p.type === 'text')
			expect(hasTextContent).toBe(true)
		},
		TIMEOUT,
	)
})
