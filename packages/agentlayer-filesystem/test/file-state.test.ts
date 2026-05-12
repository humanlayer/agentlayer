import { describe, expect, test } from 'bun:test'
import { access, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	Agent,
	defineTool,
	runPostToolUseHooks,
	runPreToolUseHooks,
	startState,
	type ToolInfo,
} from '@humanlayer/agentlayer-core'
import { z } from 'zod'
import {
	createFileStateTrackingHook,
	createReadBeforeWriteHook,
	createReadBeforeWriteHooks,
	createWastedReadHook,
	createWastedReadHooks,
	FILE_READ_STATE_KEY,
	FILE_VERIFICATION_STATE_KEY,
	type FileReadStateMap,
	type FileVerificationStateMap,
} from '../src/hooks'
import {
	assistantText,
	assistantWithToolCall,
	assistantWithToolCalls,
	getToolResults,
	mockModel,
	userMessage,
} from './mocks'

async function fileText(filePath: string): Promise<string> {
	return await readFile(filePath, 'utf8')
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch {
		return false
	}
}

function wastedReadReminder(filePath: string): string {
	return `<system-reminder>File ${filePath} is already in your context and unchanged. Refer to the previous read result.</system-reminder>`
}

function readBeforeWriteReminder(filePath: string): string {
	return `<system-reminder>You must read file ${filePath} before writing to it.</system-reminder>`
}

type DirectHookState = {
	[FILE_READ_STATE_KEY]?: FileReadStateMap
	[FILE_VERIFICATION_STATE_KEY]?: FileVerificationStateMap
}

type DirectHookHarness = {
	state: DirectHookState
	expectMutationAllowed: (toolName: string, input: Record<string, unknown>) => Promise<void>
	expectMutationBlocked: (toolName: string, input: Record<string, unknown>, filePath: string) => Promise<void>
	recordReadObservation: (input: Record<string, unknown>, rawOutput: string) => Promise<void>
	recordMutationVerification: (toolName: string, input: Record<string, unknown>, rawOutput?: unknown) => Promise<void>
}

function createDirectHookHarness(cwd?: string): DirectHookHarness {
	const state: DirectHookState = {}
	const preHook = createReadBeforeWriteHook({ cwd })
	const postHook = createFileStateTrackingHook({ cwd })
	let nextToolCallId = 0

	function toolInfo(toolName: string): ToolInfo {
		return {
			name: toolName,
			inputSchema: z.record(z.string(), z.unknown()),
		}
	}

	function applyStateUpdates(updates: Array<{ key: string; apply: (current: unknown) => unknown }>) {
		for (const update of updates) {
			state[update.key as keyof DirectHookState] = update.apply(state[update.key as keyof DirectHookState]) as never
		}
	}

	async function expectMutationAllowed(toolName: string, input: Record<string, unknown>) {
		const result = await runPreToolUseHooks([preHook], {
			toolName,
			toolCallId: `direct-${++nextToolCallId}`,
			input,
			tool: toolInfo(toolName),
			getContextWindow: () => [],
			state,
		})
		applyStateUpdates(result.stateUpdates)
		expect(result.result.type).toBe('next')
	}

	async function expectMutationBlocked(toolName: string, input: Record<string, unknown>, filePath: string) {
		const result = await runPreToolUseHooks([preHook], {
			toolName,
			toolCallId: `direct-${++nextToolCallId}`,
			input,
			tool: toolInfo(toolName),
			getContextWindow: () => [],
			state,
		})
		applyStateUpdates(result.stateUpdates)
		expect(result.result.type).toBe('toolResult')
		if (result.result.type === 'toolResult') {
			expect(result.result.output).toBe(readBeforeWriteReminder(filePath))
			expect(result.result.isError).toBe(true)
		}
	}

	async function runPostHook(toolName: string, input: Record<string, unknown>, rawOutput: unknown) {
		const result = await runPostToolUseHooks([postHook], {
			toolName,
			toolCallId: `direct-${++nextToolCallId}`,
			input,
			output: typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput),
			rawOutput,
			tool: toolInfo(toolName),
			getContextWindow: () => [],
			state,
		})
		applyStateUpdates(result.stateUpdates)
	}

	return {
		state,
		expectMutationAllowed,
		expectMutationBlocked,
		recordReadObservation: (input, rawOutput) => runPostHook('read', input, rawOutput),
		recordMutationVerification: (toolName, input, rawOutput = 'ok') => runPostHook(toolName, input, rawOutput),
	}
}

describe('file-state hooks', () => {
	test('direct hook harness records read state and gates mutations', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'sample.txt')
			const initialContent = 'alpha\nbeta\n'
			await writeFile(filePath, initialContent)
			const harness = createDirectHookHarness()

			await harness.expectMutationBlocked('write', { file_path: filePath, content: 'blocked\n' }, filePath)
			await harness.recordReadObservation({ file_path: filePath }, initialContent)
			await harness.expectMutationAllowed('write', { file_path: filePath, content: 'next\n' })

			expect(harness.state[FILE_READ_STATE_KEY]?.[filePath]?.lastReadHash).toBeString()
			expect(harness.state[FILE_VERIFICATION_STATE_KEY]?.[filePath]?.lastVerifiedHash).toBeString()
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('unchanged second read short-circuits execution', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'sample.txt')
			await writeFile(filePath, 'alpha\nbeta\n')

			let readExecuted = 0
			const readTool = defineTool({
				name: 'read',
				description: 'Read file from disk',
				input: z.object({ file_path: z.string() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return await fileText(input.file_path)
				},
			})

			const agent = new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath }),
					assistantWithToolCall('read', { file_path: filePath }),
					assistantText('Done.'),
				]),
				tools: { read: readTool },
				hooks: {
					preToolUse: [createWastedReadHook()],
					postToolUse: [createFileStateTrackingHook()],
				},
			})

			const result = await agent.run({ state: startState([userMessage('Read twice')]) }).result
			expect(readExecuted).toBe(1)
			const readResults = getToolResults(result.state.messages, { toolName: 'read' })
			expect(readResults).toHaveLength(2)
			expect(readResults[1]!.output).toEqual({
				type: 'text',
				value: wastedReadReminder(filePath),
			})
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('partial read does not block uncovered ranges', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'sample.txt')
			await writeFile(filePath, 'alpha\nbeta\ngamma\n')

			let readExecuted = 0
			const readTool = defineTool({
				name: 'read',
				description: 'Read file from disk',
				input: z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return await fileText(input.file_path)
				},
			})

			const agent = new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath, offset: 1, limit: 1 }),
					assistantWithToolCall('read', { file_path: filePath, offset: 2, limit: 1 }),
					assistantText('Done.'),
				]),
				tools: { read: readTool },
				hooks: {
					preToolUse: [createWastedReadHook()],
					postToolUse: [createFileStateTrackingHook()],
				},
			})

			const result = await agent.run({ state: startState([userMessage('Read two different ranges')]) }).result
			expect(readExecuted).toBe(2)
			const readResults = getToolResults(result.state.messages, { toolName: 'read' })
			expect(readResults).toHaveLength(2)
			expect(readResults[1]!.output).not.toEqual({
				type: 'text',
				value: wastedReadReminder(filePath),
			})
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('read is short-circuited once requested range is fully covered', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'sample.txt')
			await writeFile(filePath, 'alpha\nbeta\ngamma\n')

			let readExecuted = 0
			const readTool = defineTool({
				name: 'read',
				description: 'Read file from disk',
				input: z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return await fileText(input.file_path)
				},
			})

			const agent = new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath, offset: 1, limit: 1 }),
					assistantWithToolCall('read', { file_path: filePath, offset: 2, limit: 1 }),
					assistantWithToolCall('read', { file_path: filePath, offset: 1, limit: 2 }),
					assistantText('Done.'),
				]),
				tools: { read: readTool },
				hooks: {
					preToolUse: [createWastedReadHook()],
					postToolUse: [createFileStateTrackingHook()],
				},
			})

			const result = await agent.run({ state: startState([userMessage('Read covered ranges')]) }).result
			expect(readExecuted).toBe(2)
			const readResults = getToolResults(result.state.messages, { toolName: 'read' })
			expect(readResults).toHaveLength(3)
			expect(readResults[2]!.output).toEqual({
				type: 'text',
				value: wastedReadReminder(filePath),
			})
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('adjacent covered ranges merge and short-circuit overlapping reads', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'sample.txt')
			await writeFile(filePath, 'alpha\nbeta\ngamma\ndelta\n')

			let readExecuted = 0
			const readTool = defineTool({
				name: 'read',
				description: 'Read file from disk',
				input: z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return await fileText(input.file_path)
				},
			})

			const agent = new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath, offset: 1, limit: 100 }),
					assistantWithToolCall('read', { file_path: filePath, offset: 101, limit: 100 }),
					assistantWithToolCall('read', { file_path: filePath, offset: 50, limit: 100 }),
					assistantText('Done.'),
				]),
				tools: { read: readTool },
				hooks: {
					preToolUse: [createWastedReadHook()],
					postToolUse: [createFileStateTrackingHook()],
				},
			})

			const result = await agent.run({ state: startState([userMessage('Read adjacent ranges')]) }).result
			expect(readExecuted).toBe(2)
			const readResults = getToolResults(result.state.messages, { toolName: 'read' })
			expect(readResults[2]!.output).toEqual({
				type: 'text',
				value: wastedReadReminder(filePath),
			})
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('gapped ranges do not short-circuit reads spanning uncovered gaps', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'sample.txt')
			await writeFile(filePath, 'alpha\nbeta\ngamma\ndelta\n')

			let readExecuted = 0
			const readTool = defineTool({
				name: 'read',
				description: 'Read file from disk',
				input: z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return await fileText(input.file_path)
				},
			})

			const agent = new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath, offset: 1, limit: 100 }),
					assistantWithToolCall('read', { file_path: filePath, offset: 201, limit: 100 }),
					assistantWithToolCall('read', { file_path: filePath, offset: 90, limit: 121 }),
					assistantText('Done.'),
				]),
				tools: { read: readTool },
				hooks: {
					preToolUse: [createWastedReadHook()],
					postToolUse: [createFileStateTrackingHook()],
				},
			})

			const result = await agent.run({ state: startState([userMessage('Read ranges with a gap')]) }).result
			expect(readExecuted).toBe(3)
			const readResults = getToolResults(result.state.messages, { toolName: 'read' })
			expect(readResults[2]!.output).not.toEqual({
				type: 'text',
				value: wastedReadReminder(filePath),
			})
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('default limit does not over-block reads past line 2000', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'sample.txt')
			const largeContent = `${Array.from({ length: 2505 }, (_, index) => `line-${index + 1}`).join('\n')}\n`
			await writeFile(filePath, largeContent)

			let readExecuted = 0
			const readTool = defineTool({
				name: 'read',
				description: 'Read file from disk',
				input: z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return await fileText(input.file_path)
				},
			})

			const agent = new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath }),
					assistantWithToolCall('read', { file_path: filePath, offset: 2001, limit: 200 }),
					assistantWithToolCall('read', { file_path: filePath, offset: 1500, limit: 100 }),
					assistantText('Done.'),
				]),
				tools: { read: readTool },
				hooks: {
					preToolUse: [createWastedReadHook()],
					postToolUse: [createFileStateTrackingHook()],
				},
			})

			const result = await agent.run({ state: startState([userMessage('Read default then tail')]) }).result
			expect(readExecuted).toBe(2)
			const readResults = getToolResults(result.state.messages, { toolName: 'read' })
			expect(readResults[1]!.output).not.toEqual({
				type: 'text',
				value: wastedReadReminder(filePath),
			})
			expect(readResults[2]!.output).toEqual({
				type: 'text',
				value: wastedReadReminder(filePath),
			})
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('offset and limit normalization falls back to default read range', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'sample.txt')
			await writeFile(filePath, 'alpha\nbeta\ngamma\n')

			let readExecuted = 0
			const readTool = defineTool({
				name: 'read',
				description: 'Read file from disk',
				input: z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return await fileText(input.file_path)
				},
			})

			const agent = new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath, offset: 0, limit: 0 }),
					assistantWithToolCall('read', { file_path: filePath, offset: 1, limit: 2000 }),
					assistantText('Done.'),
				]),
				tools: { read: readTool },
				hooks: {
					preToolUse: [createWastedReadHook()],
					postToolUse: [createFileStateTrackingHook()],
				},
			})

			const result = await agent.run({ state: startState([userMessage('Read with invalid offset/limit')]) })
				.result
			expect(readExecuted).toBe(1)
			const readResults = getToolResults(result.state.messages, { toolName: 'read' })
			expect(readResults[1]!.output).toEqual({
				type: 'text',
				value: wastedReadReminder(filePath),
			})
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('coverage resets when file changes mid-run', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'sample.txt')
			await writeFile(filePath, 'version-1\nline-2\n')

			let readExecuted = 0
			let mutateExecuted = 0

			const readTool = defineTool({
				name: 'read',
				description: 'Read file from disk',
				input: z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return await fileText(input.file_path)
				},
			})

			const mutateTool = defineTool({
				name: 'mutate',
				description: 'Mutate file externally',
				input: z.object({ file_path: z.string(), content: z.string() }),
				output: z.string(),
				execute: async (input) => {
					mutateExecuted += 1
					await writeFile(input.file_path, input.content)
					return 'mutated'
				},
			})

			const agent = new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath, offset: 1, limit: 2 }),
					assistantWithToolCall('mutate', {
						file_path: filePath,
						content: 'version-2\nline-2\n',
					}),
					assistantWithToolCall('read', { file_path: filePath, offset: 1, limit: 2 }),
					assistantWithToolCall('read', { file_path: filePath, offset: 1, limit: 2 }),
					assistantText('Done.'),
				]),
				tools: { read: readTool, mutate: mutateTool },
				hooks: {
					preToolUse: [createWastedReadHook()],
					postToolUse: [createFileStateTrackingHook()],
				},
			})

			const result = await agent.run({ state: startState([userMessage('Read, mutate, read again')]) }).result
			expect(mutateExecuted).toBe(1)
			expect(readExecuted).toBe(2)

			const readResults = getToolResults(result.state.messages, { toolName: 'read' })
			expect(readResults[1]!.output).not.toEqual({
				type: 'text',
				value: wastedReadReminder(filePath),
			})
			expect(readResults[2]!.output).toEqual({
				type: 'text',
				value: wastedReadReminder(filePath),
			})
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('hook-pair helpers work with duplicated tracking post-hooks', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'sample.txt')
			await writeFile(filePath, 'line-1\nline-2\n')

			let readExecuted = 0
			let writeExecuted = 0

			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return fileText(input.file_path)
				},
			})

			const writeTool = defineTool({
				name: 'write',
				description: 'Write file',
				input: z.object({ file_path: z.string(), content: z.string() }),
				output: z.string(),
				execute: async (input) => {
					writeExecuted += 1
					await writeFile(input.file_path, input.content)
					return 'wrote'
				},
			})

			const wasted = createWastedReadHooks()
			const readBeforeWrite = createReadBeforeWriteHooks()

			const agent = new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath, offset: 1, limit: 1 }),
					assistantWithToolCall('read', { file_path: filePath, offset: 1, limit: 1 }),
					assistantWithToolCall('write', { file_path: filePath, content: 'updated\n' }),
					assistantText('Done.'),
				]),
				tools: { read: readTool, write: writeTool },
				hooks: {
					preToolUse: [wasted.preToolUseHook, readBeforeWrite.preToolUseHook],
					postToolUse: [wasted.postToolUseHook, readBeforeWrite.postToolUseHook],
				},
			})

			const result = await agent.run({ state: startState([userMessage('Use hook pairs')]) }).result
			expect(readExecuted).toBe(1)
			expect(writeExecuted).toBe(1)

			const readResults = getToolResults(result.state.messages, { toolName: 'read' })
			expect(readResults[1]!.output).toEqual({
				type: 'text',
				value: wastedReadReminder(filePath),
			})
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('changed file read executes and updates tracked hash', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'sample.txt')
			await writeFile(filePath, 'version-1\n')

			let readExecuted = 0
			const readTool = defineTool({
				name: 'read',
				description: 'Read file from disk',
				input: z.object({ file_path: z.string() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					if (readExecuted === 2) {
						const text = await fileText(input.file_path)
						return `${text} second-read`
					}
					return await fileText(input.file_path)
				},
			})

			const agent = new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath }),
					assistantWithToolCall('read', { file_path: filePath }),
					assistantText('Done.'),
				]),
				tools: { read: readTool },
				hooks: {
					preToolUse: [
						createWastedReadHook(),
						(ctx) => {
							if (ctx.toolName === 'read') {
								return ctx.next()
							}
							return ctx.next()
						},
					],
					postToolUse: [createFileStateTrackingHook()],
				},
			})

			const firstRun = await agent.run({ state: startState([userMessage('Read')]) }).result
			expect(readExecuted).toBe(1)

			await writeFile(filePath, 'version-2\n')

			const resumed = startState(
				[...firstRun.state.messages, userMessage('Read again')],
				firstRun.state.toolState,
			)
			const secondAgent = new Agent({
				model: mockModel([assistantWithToolCall('read', { file_path: filePath }), assistantText('Done.')]),
				tools: { read: readTool },
				hooks: {
					preToolUse: [createWastedReadHook()],
					postToolUse: [createFileStateTrackingHook()],
				},
			})

			await secondAgent.run({ state: resumed }).result
			expect(readExecuted).toBe(2)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('write and edit blocked when existing file has no tracked read hash', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const targetPath = join(dir, 'target.txt')
			await writeFile(targetPath, 'initial')

			let writeExecuted = 0
			const writeTool = defineTool({
				name: 'write',
				description: 'Write file',
				input: z.object({ file_path: z.string(), content: z.string() }),
				output: z.string(),
				execute: async (input) => {
					writeExecuted += 1
					await writeFile(input.file_path, input.content)
					return 'wrote'
				},
			})

			const editTool = defineTool({
				name: 'edit',
				description: 'Edit file',
				input: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() }),
				output: z.string(),
				execute: async () => {
					throw new Error('edit should not execute')
				},
			})

			const agent = new Agent({
				model: mockModel([
					assistantWithToolCall('write', { file_path: targetPath, content: 'updated' }),
					assistantWithToolCall('edit', {
						file_path: targetPath,
						old_string: 'updated',
						new_string: 'edited',
					}),
					assistantText('Done.'),
				]),
				tools: { write: writeTool, edit: editTool },
				hooks: {
					preToolUse: [createReadBeforeWriteHook()],
					postToolUse: [createFileStateTrackingHook()],
				},
			})

			const result = await agent.run({ state: startState([userMessage('Write then edit')]) }).result
			expect(writeExecuted).toBe(0)
			const results = getToolResults(result.state.messages)
			expect(results[0]!.output).toEqual({
				type: 'text',
				value: readBeforeWriteReminder(targetPath),
			})
			expect(results[1]!.output).toEqual({
				type: 'text',
				value: readBeforeWriteReminder(targetPath),
			})
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('partial read satisfies read-before-write safety for write', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'target.txt')
			await writeFile(filePath, 'line-1\nline-2\nline-3\nline-4\n')

			let readExecuted = 0
			let writeExecuted = 0

			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return fileText(input.file_path)
				},
			})

			const writeTool = defineTool({
				name: 'write',
				description: 'Write file',
				input: z.object({ file_path: z.string(), content: z.string() }),
				output: z.string(),
				execute: async (input) => {
					writeExecuted += 1
					await writeFile(input.file_path, input.content)
					return 'wrote'
				},
			})

			const agent = new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath, offset: 1, limit: 2 }),
					assistantWithToolCall('write', { file_path: filePath, content: 'updated\n' }),
					assistantText('Done.'),
				]),
				tools: { read: readTool, write: writeTool },
				hooks: {
					preToolUse: [createWastedReadHook(), createReadBeforeWriteHook()],
					postToolUse: [createFileStateTrackingHook()],
				},
			})

			const result = await agent.run({ state: startState([userMessage('Partial read then write')]) }).result
			expect(readExecuted).toBe(1)
			expect(writeExecuted).toBe(1)
			const writeResult = getToolResults(result.state.messages, { toolName: 'write' })[0]!
			expect(writeResult.output).toEqual({ type: 'text', value: 'wrote' })
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('partial read satisfies read-before-write safety for edit and apply_patch update', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const editPath = join(dir, 'edit-target.txt')
			const patchPath = join(dir, 'patch-target.txt')
			await writeFile(editPath, 'alpha\nbeta\n')
			await writeFile(patchPath, 'old\n')

			let readExecuted = 0
			let editExecuted = 0
			let applyPatchExecuted = 0

			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return fileText(input.file_path)
				},
			})

			const editTool = defineTool({
				name: 'edit',
				description: 'Edit file',
				input: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() }),
				output: z.string(),
				execute: async (input) => {
					editExecuted += 1
					const text = await fileText(input.file_path)
					await writeFile(input.file_path, text.replace(input.old_string, input.new_string))
					return 'edited'
				},
			})

			const applyPatchTool = defineTool({
				name: 'apply_patch',
				description: 'Apply patch',
				input: z.object({ patch_text: z.string() }),
				output: z.string(),
				execute: async (input) => {
					applyPatchExecuted += 1
					if (input.patch_text.includes('Update File')) {
						await writeFile(patchPath, 'new\n')
					}
					return 'patched'
				},
			})

			const updatePatch = [
				'*** Begin Patch',
				`*** Update File: ${patchPath}`,
				'@@',
				'-old',
				'+new',
				'*** End Patch',
			].join('\n')

			const hooks = {
				preToolUse: [createWastedReadHook(), createReadBeforeWriteHook()],
				postToolUse: [createFileStateTrackingHook()],
			}

			const first = await new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: editPath, offset: 1, limit: 1 }),
					assistantWithToolCall('edit', {
						file_path: editPath,
						old_string: 'alpha',
						new_string: 'ALPHA',
					}),
					assistantText('Done.'),
				]),
				tools: { read: readTool, edit: editTool },
				hooks,
			}).run({ state: startState([userMessage('Partial read then edit')]) }).result

			expect(readExecuted).toBe(1)
			expect(editExecuted).toBe(1)

			const second = await new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: patchPath, offset: 1, limit: 1 }),
					assistantWithToolCall('apply_patch', { patch_text: updatePatch }),
					assistantText('Done.'),
				]),
				tools: { read: readTool, apply_patch: applyPatchTool },
				hooks,
			}).run({
				state: startState(
					[...first.state.messages, userMessage('Partial read then patch')],
					first.state.toolState,
				),
			}).result

			expect(applyPatchExecuted).toBe(1)
			expect(await fileText(patchPath)).toBe('new\n')

			const patchResults = getToolResults(second.state.messages, { toolName: 'apply_patch' })
			expect(patchResults[0]!.output).toEqual({ type: 'text', value: 'patched' })
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('full coverage through multiple reads enables read-before-write safety', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'target.txt')
			await writeFile(filePath, 'line-1\nline-2\nline-3\nline-4\n')

			let readExecuted = 0
			let writeExecuted = 0

			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return fileText(input.file_path)
				},
			})

			const writeTool = defineTool({
				name: 'write',
				description: 'Write file',
				input: z.object({ file_path: z.string(), content: z.string() }),
				output: z.string(),
				execute: async (input) => {
					writeExecuted += 1
					await writeFile(input.file_path, input.content)
					return 'wrote'
				},
			})

			const firstRun = await new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath, offset: 1, limit: 2 }),
					assistantWithToolCall('read', { file_path: filePath, offset: 3, limit: 2 }),
					assistantText('Done.'),
				]),
				tools: { read: readTool },
				hooks: {
					preToolUse: [createWastedReadHook(), createReadBeforeWriteHook()],
					postToolUse: [createFileStateTrackingHook()],
				},
			}).run({ state: startState([userMessage('Read complete coverage')]) }).result

			expect(readExecuted).toBe(2)

			await new Agent({
				model: mockModel([
					assistantWithToolCall('write', { file_path: filePath, content: 'updated\n' }),
					assistantText('Done.'),
				]),
				tools: { write: writeTool },
				hooks: {
					preToolUse: [createWastedReadHook(), createReadBeforeWriteHook()],
					postToolUse: [createFileStateTrackingHook()],
				},
			}).run({
				state: startState([...firstRun.state.messages, userMessage('Now write')], firstRun.state.toolState),
			}).result

			expect(writeExecuted).toBe(1)
			expect(await fileText(filePath)).toBe('updated\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('write and edit allowed after read with matching checksum', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'target.txt')
			await writeFile(filePath, 'initial\n')

			let writeExecuted = 0
			let editExecuted = 0

			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string() }),
				output: z.string(),
				execute: async (input) => fileText(input.file_path),
			})

			const writeTool = defineTool({
				name: 'write',
				description: 'Write file',
				input: z.object({ file_path: z.string(), content: z.string() }),
				output: z.string(),
				execute: async (input) => {
					writeExecuted += 1
					await writeFile(input.file_path, input.content)
					return 'wrote'
				},
			})

			const editTool = defineTool({
				name: 'edit',
				description: 'Edit file',
				input: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() }),
				output: z.string(),
				execute: async (input) => {
					editExecuted += 1
					const text = await fileText(input.file_path)
					await writeFile(input.file_path, text.replace(input.old_string, input.new_string))
					return 'edited'
				},
			})

			const hooks = {
				preToolUse: [createWastedReadHook(), createReadBeforeWriteHook()],
				postToolUse: [createFileStateTrackingHook()],
			}

			const run1 = new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath }),
					assistantWithToolCall('write', { file_path: filePath, content: 'after-write\n' }),
					assistantText('Done.'),
				]),
				tools: { read: readTool, write: writeTool, edit: editTool },
				hooks,
			})

			const first = await run1.run({ state: startState([userMessage('Read then write')]) }).result
			expect(writeExecuted).toBe(1)

			const run2 = new Agent({
				model: mockModel([
					assistantWithToolCall('edit', {
						file_path: filePath,
						old_string: 'after-write',
						new_string: 'after-edit',
					}),
					assistantText('Done.'),
				]),
				tools: { read: readTool, write: writeTool, edit: editTool },
				hooks,
			})

			await run2.run({
				state: startState([...first.state.messages, userMessage('Now edit')], first.state.toolState),
			}).result

			expect(editExecuted).toBe(1)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('write edit and apply_patch refresh verification state for later writes without reread', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const writeFilePath = join(dir, 'write-then-edit.txt')
			const editFilePath = join(dir, 'edit-then-write.txt')
			const patchFilePath = join(dir, 'patch-then-edit.txt')
			await writeFile(writeFilePath, 'alpha\n')
			await writeFile(editFilePath, 'bravo\n')
			await writeFile(patchFilePath, 'charlie\n')

			let readExecuted = 0
			let writeExecuted = 0
			let editExecuted = 0
			let applyPatchExecuted = 0

			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return fileText(input.file_path)
				},
			})

			const writeTool = defineTool({
				name: 'write',
				description: 'Write file',
				input: z.object({ file_path: z.string(), content: z.string() }),
				output: z.string(),
				execute: async (input) => {
					writeExecuted += 1
					await writeFile(input.file_path, input.content)
					return 'wrote'
				},
			})

			const editTool = defineTool({
				name: 'edit',
				description: 'Edit file',
				input: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() }),
				output: z.string(),
				execute: async (input) => {
					editExecuted += 1
					const text = await fileText(input.file_path)
					await writeFile(input.file_path, text.replace(input.old_string, input.new_string))
					return 'edited'
				},
			})

			const applyPatchTool = defineTool({
				name: 'apply_patch',
				description: 'Apply patch',
				input: z.object({ patch_text: z.string() }),
				output: z.string(),
				execute: async (input) => {
					applyPatchExecuted += 1
					if (input.patch_text.includes(patchFilePath)) {
						await writeFile(patchFilePath, 'CHARLIE\n')
					}
					return 'patched'
				},
			})

			const hooks = {
				preToolUse: [createWastedReadHook(), createReadBeforeWriteHook()],
				postToolUse: [createFileStateTrackingHook()],
			}

			const first = await new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: writeFilePath }),
					assistantWithToolCall('write', { file_path: writeFilePath, content: 'ALPHA\n' }),
					assistantWithToolCall('read', { file_path: editFilePath }),
					assistantWithToolCall('edit', {
						file_path: editFilePath,
						old_string: 'bravo',
						new_string: 'BRAVO',
					}),
					assistantWithToolCall('read', { file_path: patchFilePath }),
					assistantWithToolCall('apply_patch', {
						patch_text: [
							'*** Begin Patch',
							`*** Update File: ${patchFilePath}`,
							'@@',
							'-charlie',
							'+CHARLIE',
							'*** End Patch',
						].join('\n'),
					}),
					assistantText('Done.'),
				]),
				tools: {
					read: readTool,
					write: writeTool,
					edit: editTool,
					apply_patch: applyPatchTool,
				},
				hooks,
			}).run({ state: startState([userMessage('Read and mutate files')]) }).result

			expect(readExecuted).toBe(3)
			expect(writeExecuted).toBe(1)
			expect(editExecuted).toBe(1)
			expect(applyPatchExecuted).toBe(1)

			await new Agent({
				model: mockModel([
					assistantWithToolCall('edit', {
						file_path: writeFilePath,
						old_string: 'ALPHA',
						new_string: 'alpha-after-write',
					}),
					assistantWithToolCall('write', { file_path: editFilePath, content: 'bravo-after-edit\n' }),
					assistantWithToolCall('edit', {
						file_path: patchFilePath,
						old_string: 'CHARLIE',
						new_string: 'charlie-after-patch',
					}),
					assistantText('Done.'),
				]),
				tools: {
					read: readTool,
					write: writeTool,
					edit: editTool,
					apply_patch: applyPatchTool,
				},
				hooks,
			}).run({
				state: startState(
					[...first.state.messages, userMessage('Mutate again without rereading')],
					first.state.toolState,
				),
			}).result

			expect(writeExecuted).toBe(2)
			expect(editExecuted).toBe(3)
			expect(await fileText(writeFilePath)).toBe('alpha-after-write\n')
			expect(await fileText(editFilePath)).toBe('bravo-after-edit\n')
			expect(await fileText(patchFilePath)).toBe('charlie-after-patch\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('read then write then edit does not trigger read-before-write block again', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'write-then-edit.txt')
			await writeFile(filePath, 'initial\n')

			let readExecuted = 0
			let writeExecuted = 0
			let editExecuted = 0
			let blockCount = 0

			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return fileText(input.file_path)
				},
			})

			const writeTool = defineTool({
				name: 'write',
				description: 'Write file',
				input: z.object({ file_path: z.string(), content: z.string() }),
				output: z.string(),
				execute: async (input) => {
					writeExecuted += 1
					await writeFile(input.file_path, input.content)
					return 'wrote'
				},
			})

			const editTool = defineTool({
				name: 'edit',
				description: 'Edit file',
				input: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() }),
				output: z.string(),
				execute: async (input) => {
					editExecuted += 1
					const text = await fileText(input.file_path)
					await writeFile(input.file_path, text.replace(input.old_string, input.new_string))
					return 'edited'
				},
			})

			const baseReadBeforeWriteHook = createReadBeforeWriteHook()
			const instrumentedReadBeforeWriteHook = async (ctx: Parameters<typeof baseReadBeforeWriteHook>[0]) => {
				const result = await baseReadBeforeWriteHook(ctx)
				if (result.type === 'toolResult') {
					blockCount += 1
				}
				return result
			}

			const result = await new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath }),
					assistantWithToolCall('write', { file_path: filePath, content: 'after-write\n' }),
					assistantWithToolCall('edit', {
						file_path: filePath,
						old_string: 'after-write',
						new_string: 'after-edit',
					}),
					assistantText('Done.'),
				]),
				tools: { read: readTool, write: writeTool, edit: editTool },
				hooks: {
					preToolUse: [createWastedReadHook(), instrumentedReadBeforeWriteHook],
					postToolUse: [createFileStateTrackingHook()],
				},
			}).run({ state: startState([userMessage('Read then write then edit')]) }).result

			expect(readExecuted).toBe(1)
			expect(writeExecuted).toBe(1)
			expect(editExecuted).toBe(1)
			expect(blockCount).toBe(0)
			expect(getToolResults(result.state.messages).map((part) => part.output.value)).not.toContain(
				readBeforeWriteReminder(filePath),
			)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('read then write then write uses verification state instead of stale read state', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'write-then-write.txt')
			await writeFile(filePath, 'initial\n')

			let readExecuted = 0
			let writeExecuted = 0
			let blockCount = 0

			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return fileText(input.file_path)
				},
			})

			const writeTool = defineTool({
				name: 'write',
				description: 'Write file',
				input: z.object({ file_path: z.string(), content: z.string() }),
				output: z.string(),
				execute: async (input) => {
					writeExecuted += 1
					await writeFile(input.file_path, input.content)
					return 'wrote'
				},
			})

			const baseReadBeforeWriteHook = createReadBeforeWriteHook()
			const instrumentedReadBeforeWriteHook = async (ctx: Parameters<typeof baseReadBeforeWriteHook>[0]) => {
				const result = await baseReadBeforeWriteHook(ctx)
				if (result.type === 'toolResult') {
					blockCount += 1
				}
				return result
			}

			const result = await new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath }),
					assistantWithToolCall('write', { file_path: filePath, content: 'after-first-write\n' }),
					assistantWithToolCall('write', { file_path: filePath, content: 'after-second-write\n' }),
					assistantText('Done.'),
				]),
				tools: { read: readTool, write: writeTool },
				hooks: {
					preToolUse: [createWastedReadHook(), instrumentedReadBeforeWriteHook],
					postToolUse: [createFileStateTrackingHook()],
				},
			}).run({ state: startState([userMessage('Read then write twice')]) }).result

			expect(readExecuted).toBe(1)
			expect(writeExecuted).toBe(2)
			expect(blockCount).toBe(0)
			expect(await fileText(filePath)).toBe('after-second-write\n')
			expect(getToolResults(result.state.messages).map((part) => part.output.value)).not.toContain(
				readBeforeWriteReminder(filePath),
			)

			const toolState = result.state.toolState
			expect(toolState).toBeDefined()
			if (!toolState) {
				throw new Error('expected tool state to be defined')
			}
			const readState = toolState[FILE_READ_STATE_KEY] as FileReadStateMap
			const verificationState = toolState[FILE_VERIFICATION_STATE_KEY] as FileVerificationStateMap
			expect(readState[filePath]?.lastReadHash).toBeTruthy()
			expect(verificationState[filePath]?.lastVerifiedHash).toBeTruthy()
			expect(readState[filePath]?.lastReadHash).not.toBe(verificationState[filePath]?.lastVerifiedHash)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('read then edit then write does not trigger read-before-write block again', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'edit-then-write.txt')
			await writeFile(filePath, 'initial\n')

			let readExecuted = 0
			let writeExecuted = 0
			let editExecuted = 0
			let blockCount = 0

			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return fileText(input.file_path)
				},
			})

			const writeTool = defineTool({
				name: 'write',
				description: 'Write file',
				input: z.object({ file_path: z.string(), content: z.string() }),
				output: z.string(),
				execute: async (input) => {
					writeExecuted += 1
					await writeFile(input.file_path, input.content)
					return 'wrote'
				},
			})

			const editTool = defineTool({
				name: 'edit',
				description: 'Edit file',
				input: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() }),
				output: z.string(),
				execute: async (input) => {
					editExecuted += 1
					const text = await fileText(input.file_path)
					await writeFile(input.file_path, text.replace(input.old_string, input.new_string))
					return 'edited'
				},
			})

			const baseReadBeforeWriteHook = createReadBeforeWriteHook()
			const instrumentedReadBeforeWriteHook = async (ctx: Parameters<typeof baseReadBeforeWriteHook>[0]) => {
				const result = await baseReadBeforeWriteHook(ctx)
				if (result.type === 'toolResult') {
					blockCount += 1
				}
				return result
			}

			const result = await new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: filePath }),
					assistantWithToolCall('edit', {
						file_path: filePath,
						old_string: 'initial',
						new_string: 'after-edit',
					}),
					assistantWithToolCall('write', { file_path: filePath, content: 'after-write\n' }),
					assistantText('Done.'),
				]),
				tools: { read: readTool, write: writeTool, edit: editTool },
				hooks: {
					preToolUse: [createWastedReadHook(), instrumentedReadBeforeWriteHook],
					postToolUse: [createFileStateTrackingHook()],
				},
			}).run({ state: startState([userMessage('Read then edit then write')]) }).result

			expect(readExecuted).toBe(1)
			expect(writeExecuted).toBe(1)
			expect(editExecuted).toBe(1)
			expect(blockCount).toBe(0)
			expect(getToolResults(result.state.messages).map((part) => part.output.value)).not.toContain(
				readBeforeWriteReminder(filePath),
			)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('apply_patch blocks unread existing file and allows add-file without prior read', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const existingPath = join(dir, 'existing.txt')
			const newPath = join(dir, 'new.txt')
			await writeFile(existingPath, 'old\n')

			let applyPatchExecuted = 0
			const applyPatchTool = defineTool({
				name: 'apply_patch',
				description: 'Apply patch',
				input: z.object({ patch_text: z.string() }),
				output: z.string(),
				execute: async (input) => {
					applyPatchExecuted += 1
					if (input.patch_text.includes('Add File')) {
						await writeFile(newPath, 'new\n')
					}
					return 'patched'
				},
			})

			const blockedPatch = [
				'*** Begin Patch',
				`*** Update File: ${existingPath}`,
				'@@',
				'-old',
				'+new',
				'*** End Patch',
			].join('\n')

			const addPatch = ['*** Begin Patch', `*** Add File: ${newPath}`, '+new', '*** End Patch'].join('\n')

			const hooks = {
				preToolUse: [createReadBeforeWriteHook()],
				postToolUse: [createFileStateTrackingHook()],
			}

			const blockedAgent = new Agent({
				model: mockModel([
					assistantWithToolCall('apply_patch', { patch_text: blockedPatch }),
					assistantText('Done.'),
				]),
				tools: { apply_patch: applyPatchTool },
				hooks,
			})

			const blockedResult = await blockedAgent.run({ state: startState([userMessage('Patch existing')]) }).result
			expect(applyPatchExecuted).toBe(0)
			const blockedOutput = getToolResults(blockedResult.state.messages, { toolName: 'apply_patch' })[0]!.output
			expect(blockedOutput).toEqual({
				type: 'text',
				value: readBeforeWriteReminder(existingPath),
			})

			const addAgent = new Agent({
				model: mockModel([
					assistantWithToolCall('apply_patch', { patch_text: addPatch }),
					assistantText('Done.'),
				]),
				tools: { apply_patch: applyPatchTool },
				hooks,
			})

			await addAgent.run({
				state: startState(
					[...blockedResult.state.messages, userMessage('Add file patch')],
					blockedResult.state.toolState,
				),
			}).result
			expect(applyPatchExecuted).toBe(1)
			expect(await fileExists(newPath)).toBe(true)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('parallel reads preserve verification state for multi-file apply_patch updates', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const firstPath = join(dir, 'first.txt')
			const secondPath = join(dir, 'second.txt')
			await writeFile(firstPath, 'first-old\n')
			await writeFile(secondPath, 'second-old\n')

			let readExecuted = 0
			let applyPatchExecuted = 0

			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return fileText(input.file_path)
				},
			})

			const applyPatchTool = defineTool({
				name: 'apply_patch',
				description: 'Apply patch',
				input: z.object({ patch_text: z.string() }),
				output: z.string(),
				execute: async () => {
					applyPatchExecuted += 1
					await writeFile(firstPath, 'first-new\n')
					await writeFile(secondPath, 'second-new\n')
					return 'patched'
				},
			})

			const hooks = {
				preToolUse: [createWastedReadHook(), createReadBeforeWriteHook()],
				postToolUse: [createFileStateTrackingHook()],
			}

			const first = await new Agent({
				model: mockModel([
					assistantWithToolCalls(
						{ toolName: 'read', input: { file_path: firstPath } },
						{ toolName: 'read', input: { file_path: secondPath } },
					),
					assistantText('Done'),
				]),
				tools: { read: readTool },
				hooks,
			}).run({ state: startState([userMessage('Read both files')]) }).result

			expect(readExecuted).toBe(2)

			const patchText = [
				'*** Begin Patch',
				`*** Update File: ${firstPath}`,
				'@@',
				'-first-old',
				'+first-new',
				`*** Update File: ${secondPath}`,
				'@@',
				'-second-old',
				'+second-new',
				'*** End Patch',
			].join('\n')

			const second = await new Agent({
				model: mockModel([
					assistantWithToolCall('apply_patch', { patch_text: patchText }),
					assistantText('Done'),
				]),
				tools: { read: readTool, apply_patch: applyPatchTool },
				hooks,
			}).run({
				state: startState([...first.state.messages, userMessage('Patch both files')], first.state.toolState),
			}).result

			expect(applyPatchExecuted).toBe(1)
			expect(await fileText(firstPath)).toBe('first-new\n')
			expect(await fileText(secondPath)).toBe('second-new\n')
			const patchResult = getToolResults(second.state.messages, { toolName: 'apply_patch' })[0]!
			expect(patchResult.output).toEqual({ type: 'text', value: 'patched' })
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('parallel reads preserve verification state for later writes to both files', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const firstPath = join(dir, 'first-write.txt')
			const secondPath = join(dir, 'second-write.txt')
			await writeFile(firstPath, 'first\n')
			await writeFile(secondPath, 'second\n')

			let readExecuted = 0
			let writeExecuted = 0

			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return fileText(input.file_path)
				},
			})

			const writeTool = defineTool({
				name: 'write',
				description: 'Write file',
				input: z.object({ file_path: z.string(), content: z.string() }),
				output: z.string(),
				execute: async (input) => {
					writeExecuted += 1
					await writeFile(input.file_path, input.content)
					return 'wrote'
				},
			})

			const hooks = {
				preToolUse: [createWastedReadHook(), createReadBeforeWriteHook()],
				postToolUse: [createFileStateTrackingHook()],
			}

			const first = await new Agent({
				model: mockModel([
					assistantWithToolCalls(
						{ toolName: 'read', input: { file_path: firstPath } },
						{ toolName: 'read', input: { file_path: secondPath } },
					),
					assistantText('Done'),
				]),
				tools: { read: readTool },
				hooks,
			}).run({ state: startState([userMessage('Read both files')]) }).result

			expect(readExecuted).toBe(2)

			const second = await new Agent({
				model: mockModel([
					assistantWithToolCalls(
						{ toolName: 'write', input: { file_path: firstPath, content: 'first-updated\n' } },
						{ toolName: 'write', input: { file_path: secondPath, content: 'second-updated\n' } },
					),
					assistantText('Done'),
				]),
				tools: { read: readTool, write: writeTool },
				hooks,
			}).run({
				state: startState([...first.state.messages, userMessage('Write both files')], first.state.toolState),
			}).result

			expect(writeExecuted).toBe(2)
			expect(await fileText(firstPath)).toBe('first-updated\n')
			expect(await fileText(secondPath)).toBe('second-updated\n')
			const writeResults = getToolResults(second.state.messages, { toolName: 'write' })
			expect(writeResults).toHaveLength(2)
			expect(writeResults.every((result) => result.output.value === 'wrote')).toBe(true)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('parallel reads preserve wasted-read coverage for every tracked file on resume', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const firstPath = join(dir, 'first-read.txt')
			const secondPath = join(dir, 'second-read.txt')
			await writeFile(firstPath, 'first\n')
			await writeFile(secondPath, 'second\n')

			let readExecuted = 0

			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return fileText(input.file_path)
				},
			})

			const hooks = {
				preToolUse: [createWastedReadHook()],
				postToolUse: [createFileStateTrackingHook()],
			}

			const first = await new Agent({
				model: mockModel([
					assistantWithToolCalls(
						{ toolName: 'read', input: { file_path: firstPath } },
						{ toolName: 'read', input: { file_path: secondPath } },
					),
					assistantText('Done'),
				]),
				tools: { read: readTool },
				hooks,
			}).run({ state: startState([userMessage('Read both files')]) }).result

			expect(readExecuted).toBe(2)

			const second = await new Agent({
				model: mockModel([
					assistantWithToolCalls(
						{ toolName: 'read', input: { file_path: firstPath } },
						{ toolName: 'read', input: { file_path: secondPath } },
					),
					assistantText('Done'),
				]),
				tools: { read: readTool },
				hooks,
			}).run({
				state: startState(
					[...first.state.messages, userMessage('Read both files again')],
					first.state.toolState,
				),
			}).result

			expect(readExecuted).toBe(2)
			const readResults = getToolResults(second.state.messages, { toolName: 'read' })
			expect(readResults).toHaveLength(4)
			expect(readResults[2]!.output).toEqual({ type: 'text', value: wastedReadReminder(firstPath) })
			expect(readResults[3]!.output).toEqual({ type: 'text', value: wastedReadReminder(secondPath) })
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('state persists across resumed runs', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const filePath = join(dir, 'resume.txt')
			await writeFile(filePath, 'resume-v1\n')

			let readExecuted = 0
			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string() }),
				output: z.string(),
				execute: async (input) => {
					readExecuted += 1
					return fileText(input.file_path)
				},
			})

			const hooks = {
				preToolUse: [createWastedReadHook()],
				postToolUse: [createFileStateTrackingHook()],
			}

			const firstAgent = new Agent({
				model: mockModel([assistantWithToolCall('read', { file_path: filePath }), assistantText('Pause')]),
				tools: { read: readTool },
				hooks,
			})

			const first = await firstAgent.run({ state: startState([userMessage('Read once')]) }).result
			expect(readExecuted).toBe(1)

			const secondAgent = new Agent({
				model: mockModel([assistantWithToolCall('read', { file_path: filePath }), assistantText('Done')]),
				tools: { read: readTool },
				hooks,
			})

			const second = await secondAgent.run({
				state: startState([...first.state.messages, userMessage('Read again')], first.state.toolState),
			}).result

			expect(readExecuted).toBe(1)
			const secondResult = getToolResults(second.state.messages, { toolName: 'read' })[1]!
			expect(secondResult.output).toEqual({
				type: 'text',
				value: wastedReadReminder(filePath),
			})
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('apply_patch move updates verification state to destination path', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const sourcePath = join(dir, 'from.txt')
			const destinationPath = join(dir, 'to.txt')
			await writeFile(sourcePath, 'move-me\n')

			let applyPatchExecuted = 0
			const applyPatchTool = defineTool({
				name: 'apply_patch',
				description: 'Apply patch',
				input: z.object({ patch_text: z.string() }),
				output: z.string(),
				execute: async (input) => {
					applyPatchExecuted += 1
					if (input.patch_text.includes('Move to')) {
						await writeFile(destinationPath, await fileText(sourcePath))
						await unlink(sourcePath)
					}
					return 'patched'
				},
			})

			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string() }),
				output: z.string(),
				execute: async (input) => fileText(input.file_path),
			})

			const hooks = {
				preToolUse: [createWastedReadHook(), createReadBeforeWriteHook()],
				postToolUse: [createFileStateTrackingHook()],
			}

			const movePatch = [
				'*** Begin Patch',
				`*** Update File: ${sourcePath}`,
				`*** Move to: ${destinationPath}`,
				'@@',
				' move-me',
				'*** End Patch',
			].join('\n')

			const first = await new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: sourcePath }),
					assistantWithToolCall('apply_patch', { patch_text: movePatch }),
					assistantText('Done'),
				]),
				tools: { read: readTool, apply_patch: applyPatchTool },
				hooks,
			}).run({ state: startState([userMessage('read and move')]) }).result

			expect(applyPatchExecuted).toBe(1)

			let writeExecuted = 0
			const writeTool = defineTool({
				name: 'write',
				description: 'Write file',
				input: z.object({ file_path: z.string(), content: z.string() }),
				output: z.string(),
				execute: async (input) => {
					writeExecuted += 1
					await writeFile(input.file_path, input.content)
					return 'wrote'
				},
			})

			await new Agent({
				model: mockModel([
					assistantWithToolCall('write', { file_path: destinationPath, content: 'moved-and-updated\n' }),
					assistantText('Done'),
				]),
				tools: { read: readTool, apply_patch: applyPatchTool, write: writeTool },
				hooks,
			}).run({
				state: startState(
					[...first.state.messages, userMessage('write moved file without re-read')],
					first.state.toolState,
				),
			}).result

			expect(writeExecuted).toBe(1)
			expect(await fileText(destinationPath)).toBe('moved-and-updated\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('apply_patch delete removes tracked state for deleted file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'file-state-hook-test-'))
		try {
			const deletePath = join(dir, 'remove.txt')
			await writeFile(deletePath, 'remove-me\n')

			let applyPatchExecuted = 0
			const applyPatchTool = defineTool({
				name: 'apply_patch',
				description: 'Apply patch',
				input: z.object({ patch_text: z.string() }),
				output: z.string(),
				execute: async (input) => {
					applyPatchExecuted += 1
					if (input.patch_text.includes('Delete File')) {
						await unlink(deletePath)
					}
					return 'patched'
				},
			})

			const readTool = defineTool({
				name: 'read',
				description: 'Read file',
				input: z.object({ file_path: z.string() }),
				output: z.string(),
				execute: async (input) => fileText(input.file_path),
			})

			const hooks = {
				preToolUse: [createWastedReadHook(), createReadBeforeWriteHook()],
				postToolUse: [createFileStateTrackingHook()],
			}

			const deletePatch = ['*** Begin Patch', `*** Delete File: ${deletePath}`, '*** End Patch'].join('\n')

			const first = await new Agent({
				model: mockModel([
					assistantWithToolCall('read', { file_path: deletePath }),
					assistantWithToolCall('apply_patch', { patch_text: deletePatch }),
					assistantText('Done'),
				]),
				tools: { read: readTool, apply_patch: applyPatchTool },
				hooks,
			}).run({ state: startState([userMessage('read and delete')]) }).result

			expect(applyPatchExecuted).toBe(1)
			expect(await fileExists(deletePath)).toBe(false)

			const recreatedContent = 'recreated\n'
			const writeTool = defineTool({
				name: 'write',
				description: 'Write file',
				input: z.object({ file_path: z.string(), content: z.string() }),
				output: z.string(),
				execute: async (input) => {
					await writeFile(input.file_path, input.content)
					return 'wrote'
				},
			})

			await new Agent({
				model: mockModel([
					assistantWithToolCall('write', { file_path: deletePath, content: recreatedContent }),
					assistantText('Done'),
				]),
				tools: { write: writeTool, apply_patch: applyPatchTool },
				hooks,
			}).run({
				state: startState([...first.state.messages, userMessage('recreate file')], first.state.toolState),
			}).result

			expect(await fileText(deletePath)).toBe(recreatedContent)
		} finally {
			await rm(dir, { recursive: true })
		}
	})
})
