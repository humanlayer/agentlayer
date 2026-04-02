import { describe, expect, test } from 'bun:test'
import { Bash } from 'just-bash'
import { Agent, startState } from '../src'
import { createJustBashTool } from '../src/tools/just-bash/index'
import { assistantText, assistantWithToolCall, getToolResults, mockModel, outputValue, userMessage } from './mocks'

describe.concurrent('core loop', () => {
	test('agent executes bash tool and gets result', async () => {
		const bash = new Bash({
			files: { '/project/hello.txt': 'hello world' },
			cwd: '/project',
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'cat hello.txt' }),
				assistantText("The file contains 'hello world'."),
			]),
			tools: { bash: createJustBashTool(bash) },
		})

		const result = await agent.run({
			state: startState([userMessage("What's in hello.txt?")]),
		}).result

		expect(result.finishReason).toBe('complete')
		// newMessages: assistant(tool-call), tool(result), assistant(text) = 3
		expect(result.newMessages).toHaveLength(3)

		// The tool result message should contain the file content
		const [toolResultPart] = getToolResults(result.newMessages)
		expect(toolResultPart).toBeDefined()
		expect(outputValue(toolResultPart!)).toContain('hello world')
	})

	test('agent stops after maxSteps', async () => {
		const bash = new Bash({ cwd: '/tmp' })
		const agent = new Agent({
			model: mockModel(Array(100).fill(assistantWithToolCall('bash', { command: 'echo hi' }))),
			tools: { bash: createJustBashTool(bash) },
			maxSteps: 3,
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.finishReason).toBe('maxSteps')
	})

	test('agent stops when model responds with text only', async () => {
		const agent = new Agent({
			model: mockModel([assistantText("I don't need any tools for this.")]),
			tools: { bash: createJustBashTool(new Bash()) },
		})

		const result = await agent.run({ state: startState([userMessage('hello')]) }).result
		expect(result.finishReason).toBe('complete')
		// Just one assistant text message
		expect(result.newMessages).toHaveLength(1)
	})

	test('messages accumulate correctly across steps', async () => {
		const bash = new Bash({
			files: {
				'/project/a.txt': 'file a',
				'/project/b.txt': 'file b',
			},
			cwd: '/project',
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'cat a.txt' }),
				assistantWithToolCall('bash', { command: 'cat b.txt' }),
				assistantText('Both files read successfully.'),
			]),
			tools: { bash: createJustBashTool(bash) },
		})

		const result = await agent.run({
			state: startState([userMessage('Read both files')]),
		}).result

		expect(result.finishReason).toBe('complete')
		// 2 tool calls + 2 tool results + 1 text = 5 new messages
		expect(result.newMessages).toHaveLength(5)
		// Full messages: 1 user + 5 new = 6
		expect(result.state.messages).toHaveLength(6)
	})

	test('tool output includes exit code and stdout', async () => {
		const bash = new Bash({
			files: { '/project/test.txt': 'test content' },
			cwd: '/project',
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('bash', { command: 'cat test.txt' }), assistantText('Done.')]),
			tools: { bash: createJustBashTool(bash) },
		})

		const result = await agent.run({
			state: startState([userMessage('read test.txt')]),
		}).result

		const [toolResultPart] = getToolResults(result.newMessages)
		expect(toolResultPart).toBeDefined()
		expect(outputValue(toolResultPart!)).toContain('Exit code: 0')
		expect(outputValue(toolResultPart!)).toContain('test content')
	})
})
