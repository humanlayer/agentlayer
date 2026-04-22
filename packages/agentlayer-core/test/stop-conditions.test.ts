import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
	Agent,
	type AgentEvent,
	consecutiveToolFailures,
	defineTool,
	doomLoop,
	maxSteps,
	type StopConditionDef,
	shouldStop,
	startState,
	toolCalled,
	toolCompleted,
	totalToolFailures,
} from '../src'
import {
	assistantText,
	assistantWithToolCall,
	getToolResults,
	mockModel,
	mockStreamingModel,
	userMessage,
} from './mocks'

const bashTool = defineTool({
	name: 'bash',
	description: 'Mock bash tool',
	input: z.object({ command: z.string() }),
	execute: async (input) => `Exit code: 0\n${input.command}`,
})

const doneTool = defineTool({
	name: 'done',
	description: 'Signal completion',
	input: z.object({}),
	execute: async () => 'Done.',
})

const failTool = defineTool({
	name: 'fail',
	description: 'A tool that always fails',
	input: z.object({}),
	execute: async () => {
		throw new Error('intentional failure')
	},
})

// ─── maxSteps ────────────────────────────────────────────────────────────────

describe('maxSteps', () => {
	test('stops after n steps and reports which condition fired', async () => {
		const agent = new Agent({
			model: mockModel(Array(100).fill(assistantWithToolCall('bash', { command: 'echo hi' }))),
			tools: { bash: bashTool },
			stopWhen: maxSteps(3),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition).toBeDefined()
		expect(result.stopCondition!.name).toBe('maxSteps')
		expect(result.stopCondition!.message).toBe('Maximum steps (3) reached')
		expect(result.newMessages).toHaveLength(6)
	})

	test('maxSteps(1) stops after a single step', async () => {
		const agent = new Agent({
			model: mockModel(Array(10).fill(assistantWithToolCall('bash', { command: 'echo hi' }))),
			tools: { bash: bashTool },
			stopWhen: maxSteps(1),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('maxSteps')
		expect(result.newMessages).toHaveLength(2) // 1 assistant + 1 tool result
	})
})

// ─── toolCalled ──────────────────────────────────────────────────────────────

describe('toolCalled', () => {
	test('stops before the tool is executed and reports condition', async () => {
		let toolWasExecuted = false
		const spyTool = defineTool({
			name: 'deploy',
			description: 'Deploy to production',
			input: z.object({}),
			execute: async () => {
				toolWasExecuted = true
				return 'Deployed.'
			},
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo preparing' }),
				assistantWithToolCall('deploy', {}),
			]),
			tools: { bash: bashTool, deploy: spyTool },
			stopWhen: toolCalled('deploy'),
		})

		const result = await agent.run({ state: startState([userMessage('deploy to prod')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('toolCalled:deploy')
		expect(result.stopCondition!.message).toBe('Tool "deploy" was called')
		expect(toolWasExecuted).toBe(false)

		// Last message is the assistant's tool call (no tool result follows)
		const lastMsg = result.newMessages[result.newMessages.length - 1]!
		expect(lastMsg.role).toBe('assistant')
		const content = lastMsg.content as Array<{ type: string; toolName?: string }>
		expect(content.some((c) => c.type === 'tool-call' && c.toolName === 'deploy')).toBe(true)
	})

	test('does not stop when a different tool is called', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo step1' }),
				assistantWithToolCall('bash', { command: 'echo step2' }),
				assistantText('Finished without deploy.'),
			]),
			tools: { bash: bashTool, done: doneTool },
			stopWhen: toolCalled('deploy'),
		})

		const result = await agent.run({ state: startState([userMessage('do stuff')]) }).result

		expect(result.finishReason).toBe('complete')
		expect(result.stopCondition).toBeUndefined()
	})

	test('streaming deltas do not satisfy toolCalled stop conditions before finalized tool calls exist', async () => {
		let toolWasExecuted = false
		const deployTool = defineTool({
			name: 'deploy',
			description: 'Deploy to production',
			input: z.object({}),
			execute: async () => {
				toolWasExecuted = true
				return 'Deployed.'
			},
		})

		const agent = new Agent({
			model: mockStreamingModel([assistantWithToolCall('deploy', {})]),
			tools: { deploy: deployTool },
			stopWhen: toolCalled('deploy'),
		})

		const run = agent.run({ state: startState([userMessage('deploy now')]), stream: true })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const result = await run.result
		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition?.name).toBe('toolCalled:deploy')
		expect(toolWasExecuted).toBe(false)

		const eventTypes = events.map((event) => event.type)
		expect(eventTypes).toContain('toolInputDelta')
		expect(eventTypes).toContain('stepFinish')
		expect(eventTypes).toContain('message')
		expect(eventTypes).not.toContain('approvalRequested')
		expect(eventTypes.indexOf('toolInputDelta')).toBeLessThan(eventTypes.indexOf('stepFinish'))
		expect(eventTypes.indexOf('stepFinish')).toBeLessThan(eventTypes.indexOf('message'))

		const toolMessages = result.state.messages.filter((message) => message.role === 'tool')
		expect(toolMessages).toHaveLength(0)

		const lastMessage = result.state.messages[result.state.messages.length - 1]!
		expect(lastMessage.role).toBe('assistant')
		const content = lastMessage.content as Array<{ type: string; toolName?: string }>
		expect(content.some((part) => part.type === 'tool-call' && part.toolName === 'deploy')).toBe(true)
	})
})

// ─── toolCompleted ───────────────────────────────────────────────────────────

describe('toolCompleted', () => {
	test('stops after the tool executes successfully and reports condition', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo working' }),
				assistantWithToolCall('done', {}),
				assistantText('Should not get here.'),
			]),
			tools: { bash: bashTool, done: doneTool },
			stopWhen: toolCompleted('done'),
		})

		const result = await agent.run({ state: startState([userMessage('do stuff')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('toolCompleted:done')
		expect(result.stopCondition!.message).toBe('Tool "done" completed successfully')
		expect(result.newMessages).toHaveLength(4)

		// Last message is the tool result (execution completed)
		const lastMsg = result.newMessages[result.newMessages.length - 1]!
		expect(lastMsg.role).toBe('tool')
		expect(getToolResults([lastMsg], { toolName: 'done' })).toHaveLength(1)
	})

	test('does not trigger on a failed tool execution', async () => {
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('fail', {}), assistantText('OK it failed.')]),
			tools: { fail: failTool },
			stopWhen: toolCompleted('fail'),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')
		expect(result.stopCondition).toBeUndefined()
	})

	test('does not stop early when a different tool completes', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo hi' }),
				assistantWithToolCall('bash', { command: 'echo hi' }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool, done: doneTool },
			stopWhen: toolCompleted('done'),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')
	})

	test('does not trigger when preToolUse hook returns toolResult with isError: true', async () => {
		// This tests the fix for the code quality agent issue where validation hook
		// returning ctx.toolResult('error', { isError: true }) should NOT trigger
		// toolCompleted('done') stop condition
		const doneTool = defineTool({
			name: 'done',
			description: 'Signal completion',
			input: z.object({ description: z.string() }),
			execute: async (input) => `Fix complete: ${input.description}`,
		})

		let validationAttempts = 0
		const validationHook = (ctx: any) => {
			validationAttempts++
			if (validationAttempts === 1) {
				// First attempt: validation fails
				return ctx.toolResult('Validation failed. Please fix and try again.', { isError: true })
			}
			// Second attempt: let it through
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('done', { description: 'first attempt' }),
				// After seeing error, agent tries again
				assistantWithToolCall('done', { description: 'second attempt after fix' }),
				assistantText('Should not get here.'),
			]),
			tools: { done: doneTool },
			hooks: { preToolUse: [validationHook] },
			stopWhen: toolCompleted('done'),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		// Should have stopped on second done call (which succeeded)
		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('toolCompleted:done')
		expect(validationAttempts).toBe(2)

		// Verify first tool result has isError: true, second is not an error
		const toolResults = getToolResults(result.state.messages, { toolName: 'done' })
		expect(toolResults).toHaveLength(2)
		expect(toolResults[0]!.isError).toBe(true)
		expect(toolResults[1]!.isError).toBeFalsy()
	})
})

// ─── totalToolFailures ───────────────────────────────────────────────────────

describe('totalToolFailures', () => {
	test('counts failures across non-consecutive steps and reports condition', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('fail', {}),
				assistantWithToolCall('bash', { command: 'echo ok' }),
				assistantWithToolCall('fail', {}),
				assistantText('Should not get here.'),
			]),
			tools: { fail: failTool, bash: bashTool },
			stopWhen: totalToolFailures(2),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('totalToolFailures')
		expect(result.stopCondition!.message).toBe('2 total tool failure(s) reached')
		expect(result.newMessages).toHaveLength(6)
	})

	test('filters by tool name when specified', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('fail', {}),
				assistantWithToolCall('fail', {}),
				assistantText('Done.'),
			]),
			tools: { fail: failTool, bash: bashTool },
			stopWhen: totalToolFailures(1, 'bash'),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		// 'bash' never failed, so totalToolFailures('bash') never triggered
		expect(result.finishReason).toBe('complete')
	})

	test('reports tool-specific name when filtering', async () => {
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('fail', {}), assistantText('Should not get here.')]),
			tools: { fail: failTool },
			stopWhen: totalToolFailures(1, 'fail'),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.stopCondition!.name).toBe('totalToolFailures:fail')
		expect(result.stopCondition!.message).toBe('Tool "fail" failed 1 time(s) total')
	})
})

// ─── consecutiveToolFailures ─────────────────────────────────────────────────

describe('consecutiveToolFailures', () => {
	test('stops after threshold consecutive failures and reports condition', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo ok' }),
				assistantWithToolCall('fail', {}),
				assistantWithToolCall('fail', {}),
				assistantWithToolCall('fail', {}),
				assistantText('Should not get here.'),
			]),
			tools: { fail: failTool, bash: bashTool },
			stopWhen: consecutiveToolFailures(3),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('consecutiveToolFailures')
		expect(result.stopCondition!.message).toBe('3 consecutive tool failure(s)')
		expect(result.newMessages).toHaveLength(8)
	})

	test('resets streak when a success occurs', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('fail', {}),
				assistantWithToolCall('fail', {}),
				assistantWithToolCall('bash', { command: 'echo ok' }),
				assistantWithToolCall('fail', {}),
				assistantText('Done.'),
			]),
			tools: { fail: failTool, bash: bashTool },
			stopWhen: consecutiveToolFailures(3),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		// Streak was 2, then reset by bash success, then only 1 more failure
		expect(result.finishReason).toBe('complete')
	})

	test('filters by tool name when specified', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('fail', {}),
				assistantWithToolCall('fail', {}),
				assistantWithToolCall('fail', {}),
				assistantText('Done.'),
			]),
			tools: { fail: failTool, bash: bashTool },
			stopWhen: consecutiveToolFailures(3, 'bash'),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		// 'fail' tool failed 3x in a row, but we're only watching 'bash'
		expect(result.finishReason).toBe('complete')
	})
})

// ─── doomLoop ────────────────────────────────────────────────────────────────

describe('doomLoop', () => {
	test('stops after N identical consecutive tool calls and reports condition', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo stuck' }),
				assistantWithToolCall('bash', { command: 'echo stuck' }),
				assistantWithToolCall('bash', { command: 'echo stuck' }),
				assistantText('Should not get here.'),
			]),
			tools: { bash: bashTool },
			stopWhen: doomLoop(3),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('doomLoop')
		expect(result.stopCondition!.message).toBe('Same tool called with identical input 3 times in a row')
		expect(result.newMessages).toHaveLength(6)
	})

	test('does not trigger when inputs differ', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo 1' }),
				assistantWithToolCall('bash', { command: 'echo 2' }),
				assistantWithToolCall('bash', { command: 'echo 3' }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			stopWhen: doomLoop(3),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')
	})

	test('does not trigger when consecutive streak is broken', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo hi' }),
				assistantWithToolCall('bash', { command: 'echo hi' }),
				assistantWithToolCall('bash', { command: 'echo hi3' }),
				assistantWithToolCall('bash', { command: 'echo hi' }),
				assistantWithToolCall('done', {}),
				assistantWithToolCall('bash', { command: 'echo hi' }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool, done: doneTool },
			stopWhen: doomLoop(3),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')
	})
})

// ─── custom stop condition ───────────────────────────────────────────────────

describe('custom stop condition (StopConditionDef)', () => {
	test('custom condition with name and message', async () => {
		const customCondition: StopConditionDef = {
			name: 'myCustomStop',
			message: 'Custom condition triggered after 2 steps',
			check: (steps) => steps.length >= 2,
		}

		const agent = new Agent({
			model: mockModel(Array(10).fill(assistantWithToolCall('bash', { command: 'echo hi' }))),
			tools: { bash: bashTool },
			stopWhen: customCondition,
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('myCustomStop')
		expect(result.stopCondition!.message).toBe('Custom condition triggered after 2 steps')
		expect(result.newMessages).toHaveLength(4)
	})

	test('custom condition with onTriggered callback', async () => {
		let callbackFired = false
		let callbackCount = 0

		const customCondition: StopConditionDef = {
			name: 'callbackCondition',
			check: (steps) => steps.length >= 2,
			onTriggered: () => {
				callbackFired = true
				callbackCount++
			},
		}

		const agent = new Agent({
			model: mockModel(Array(10).fill(assistantWithToolCall('bash', { command: 'echo hi' }))),
			tools: { bash: bashTool },
			stopWhen: customCondition,
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(callbackFired).toBe(true)
		expect(callbackCount).toBe(1) // only fires once ��� the moment it triggers
	})

	test('custom beforeExecution condition', async () => {
		let bashExecuted = false
		const spyBash = defineTool({
			name: 'bash',
			description: 'Bash',
			input: z.object({ command: z.string() }),
			execute: async () => {
				bashExecuted = true
				return 'ok'
			},
		})

		const customCondition: StopConditionDef = {
			name: 'preExecGate',
			timing: 'beforeExecution',
			message: 'Stopped before executing bash',
			check: (steps) => {
				if (steps.length === 0) return false
				const lastStep = steps[steps.length - 1]!
				return lastStep.toolCalls.some((tc) => tc.toolName === 'bash')
			},
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('bash', { command: 'echo hi' })]),
			tools: { bash: spyBash },
			stopWhen: customCondition,
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('preExecGate')
		expect(bashExecuted).toBe(false)
	})

	test('receives completed steps with correct count', async () => {
		const stepsSeenByCondition: number[] = []

		const agent = new Agent({
			model: mockModel(Array(10).fill(assistantWithToolCall('bash', { command: 'echo hi' }))),
			tools: { bash: bashTool },
			stopWhen: {
				name: 'stepCounter',
				check: (steps) => {
					stepsSeenByCondition.push(steps.length)
					return steps.length >= 2
				},
			},
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(stepsSeenByCondition).toEqual([1, 2])
		expect(result.newMessages).toHaveLength(4)
	})
})

// ─── multiple conditions (array) ────────────────────────────────────────────

describe('stopWhen array — multiple conditions', () => {
	test('first matching condition triggers stop and is reported', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo step 1' }),
				assistantWithToolCall('done', {}),
				assistantText('Should not get here.'),
			]),
			tools: { bash: bashTool, done: doneTool },
			stopWhen: [maxSteps(10), toolCompleted('done')],
		})

		const result = await agent.run({ state: startState([userMessage('do stuff')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('toolCompleted:done')
		expect(result.newMessages).toHaveLength(4)
	})

	test('maxSteps fires first when it wins the race', async () => {
		const agent = new Agent({
			model: mockModel(Array(10).fill(assistantWithToolCall('bash', { command: 'echo hi' }))),
			tools: { bash: bashTool, done: doneTool },
			stopWhen: [maxSteps(2), toolCompleted('done')],
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('maxSteps')
		expect(result.stopCondition!.message).toBe('Maximum steps (2) reached')
	})

	test('beforeExecution condition wins over afterExecution in same step', async () => {
		// toolCalled is beforeExecution, doomLoop is afterExecution.
		// Both would fire on the same step, but beforeExecution runs first.
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo stuck' }),
				assistantWithToolCall('bash', { command: 'echo stuck' }),
				assistantWithToolCall('bash', { command: 'echo stuck' }),
			]),
			tools: { bash: bashTool },
			stopWhen: [doomLoop(3), toolCalled('bash')],
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		// toolCalled fires at beforeExecution on step 1, before doomLoop can accumulate
		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('toolCalled:bash')
	})

	test('only the triggered condition fires onTriggered, not others', async () => {
		let maxStepsCallbackFired = false
		let doneCallbackFired = false

		const maxStepsCond: StopConditionDef = {
			name: 'maxSteps',
			message: 'Max steps reached',
			check: (steps) => steps.length >= 10,
			onTriggered: () => {
				maxStepsCallbackFired = true
			},
		}

		const doneCond: StopConditionDef = {
			name: 'toolCompleted:done',
			message: 'Done tool completed',
			check: (steps) => {
				if (steps.length === 0) return false
				const last = steps[steps.length - 1]!
				return last.toolResults.some((tr) => tr.toolName === 'done' && !tr.isError)
			},
			onTriggered: () => {
				doneCallbackFired = true
			},
		}

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo working' }),
				assistantWithToolCall('done', {}),
			]),
			tools: { bash: bashTool, done: doneTool },
			stopWhen: [maxStepsCond, doneCond],
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('toolCompleted:done')
		expect(doneCallbackFired).toBe(true)
		expect(maxStepsCallbackFired).toBe(false)
	})

	test('three conditions: maxSteps + doomLoop + toolCompleted', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo stuck' }),
				assistantWithToolCall('bash', { command: 'echo stuck' }),
				assistantWithToolCall('bash', { command: 'echo stuck' }),
				assistantText('Should not get here.'),
			]),
			tools: { bash: bashTool, done: doneTool },
			stopWhen: [maxSteps(10), doomLoop(3), toolCompleted('done')],
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('doomLoop')
	})

	test('four conditions: failure-based conditions combine correctly', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('fail', {}),
				assistantWithToolCall('fail', {}),
				assistantWithToolCall('bash', { command: 'echo ok' }),
				assistantWithToolCall('fail', {}),
				assistantWithToolCall('fail', {}),
				assistantText('Should not get here.'),
			]),
			tools: { fail: failTool, bash: bashTool },
			stopWhen: [
				maxSteps(20),
				consecutiveToolFailures(3), // never reaches 3 consecutive
				totalToolFailures(4), // fires at 4 total failures
			],
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('totalToolFailures')
	})

	test('does not interfere with natural completion', async () => {
		const agent = new Agent({
			model: mockModel([assistantText('Done, no tools needed.')]),
			tools: { bash: bashTool },
			stopWhen: maxSteps(5),
		})

		const result = await agent.run({ state: startState([userMessage('hello')]) }).result

		expect(result.finishReason).toBe('complete')
		expect(result.stopCondition).toBeUndefined()
		expect(result.newMessages).toHaveLength(1)
	})
})

// ─── shouldStop unit tests ───────────────────────────────────────────────────

describe('shouldStop (direct)', () => {
	test('returns null when no condition fires', () => {
		const result = shouldStop(maxSteps(5), [])
		expect(result).toBeNull()
	})

	test('returns StopResult with name and message when condition fires', () => {
		const steps: any[] = [
			{ toolCalls: [], toolResults: [] },
			{ toolCalls: [], toolResults: [] },
		]
		const result = shouldStop(maxSteps(2), steps)

		expect(result).not.toBeNull()
		expect(result!.name).toBe('maxSteps')
		expect(result!.message).toBe('Maximum steps (2) reached')
	})

	test('respects timing filter — skips afterExecution conditions during beforeExecution phase', () => {
		const steps: any[] = [
			{ toolCalls: [], toolResults: [] },
			{ toolCalls: [], toolResults: [] },
		]
		// maxSteps has no timing set, defaults to afterExecution
		const result = shouldStop(maxSteps(2), steps, 'beforeExecution')
		expect(result).toBeNull()
	})

	test('evaluates array in order — first match wins', () => {
		const steps: any[] = [
			{ toolCalls: [], toolResults: [] },
			{ toolCalls: [], toolResults: [] },
			{ toolCalls: [], toolResults: [] },
		]
		const result = shouldStop([maxSteps(2), maxSteps(3)], steps)

		expect(result).not.toBeNull()
		expect(result!.message).toBe('Maximum steps (2) reached')
	})

	test('calls onTriggered on the winning condition', () => {
		let triggered = false
		const cond: StopConditionDef = {
			name: 'test',
			check: () => true,
			onTriggered: () => {
				triggered = true
			},
		}

		shouldStop(cond, [{ toolCalls: [], toolResults: [] } as any])
		expect(triggered).toBe(true)
	})

	test('does not call onTriggered on non-matching conditions', () => {
		let triggered = false
		const cond: StopConditionDef = {
			name: 'neverFires',
			check: () => false,
			onTriggered: () => {
				triggered = true
			},
		}

		shouldStop(cond, [{ toolCalls: [], toolResults: [] } as any])
		expect(triggered).toBe(false)
	})
})

// ─── edge cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {
	test('no stopWhen configured — falls back to maxSteps limit', async () => {
		const agent = new Agent({
			model: mockModel(Array(5).fill(assistantWithToolCall('bash', { command: 'echo hi' }))),
			tools: { bash: bashTool },
			maxSteps: 3,
			// no stopWhen
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('maxSteps')
		expect(result.stopCondition).toBeUndefined()
	})

	test('stopWhen and maxSteps both set — stopWhen checked first per step', async () => {
		const agent = new Agent({
			model: mockModel(Array(5).fill(assistantWithToolCall('bash', { command: 'echo hi' }))),
			tools: { bash: bashTool },
			maxSteps: 3,
			stopWhen: maxSteps(2),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('maxSteps')
		expect(result.newMessages).toHaveLength(4) // 2 steps, not 3
	})

	test('empty stopWhen array — never triggers, falls through to maxSteps', async () => {
		const agent = new Agent({
			model: mockModel(Array(5).fill(assistantWithToolCall('bash', { command: 'echo hi' }))),
			tools: { bash: bashTool },
			maxSteps: 3,
			stopWhen: [],
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('maxSteps')
	})
})
