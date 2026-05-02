import { describe, expect, test } from 'bun:test'
import { Agent, startState } from '@humanlayer/agentlayer-core'
import { DeleteFileTool } from '@humanlayer/agentlayer-core/interfaces'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import * as Y from 'yjs'
import { createYjsFsPresenceHooks, lineEndOffset, lineToOffset } from '../src/hooks'
import { createYjsFsApplyPatchTool, createYjsFsEditTool, createYjsFsReadTool, createYjsFsWriteTool } from '../src/tools'
import { assistantText, assistantWithToolCall, getToolResults, mockModel, outputValue, userMessage } from './mocks'

const { Awareness } = await import('y-protocols/awareness')

function createFsWithAwareness() {
	const doc = new Y.Doc()
	const awareness = new Awareness(doc)
	const fs = new YjsFilesystem({ doc, awareness })
	return { fs, awareness }
}

describe('presence helpers — line offsets', () => {
	test('converts 1-based line numbers to offsets', () => {
		const content = 'one\ntwo\nthree'
		expect(lineToOffset(content, 1)).toBe(0)
		expect(lineToOffset(content, 2)).toBe(4)
		expect(lineToOffset(content, 3)).toBe(8)
		expect(lineToOffset(content, 99)).toBe(content.length)
	})

	test('converts 1-based line numbers to line end offsets', () => {
		const content = 'one\ntwo\nthree'
		expect(lineEndOffset(content, 1)).toBe(3)
		expect(lineEndOffset(content, 2)).toBe(7)
		expect(lineEndOffset(content, 3)).toBe(content.length)
	})
})

describe('createYjsFsPresenceHooks — tool presence', () => {
	test('read hook sets current file, reading action, and whole-file selection', async () => {
		const { fs, awareness } = createFsWithAwareness()
		fs.createFile('/notes.txt', 'hello\nworld')
		const readTool = createYjsFsReadTool(fs)
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('read', { file_path: '/notes.txt' }), assistantText('Done.')]),
			tools: { read: readTool },
			hooks: { postToolUse: createYjsFsPresenceHooks(fs, { selectionFadeMs: 60_000 }) },
		})

		const result = await agent.run({ state: startState([userMessage('read it')]) }).result
		const [toolResult] = getToolResults(result.state.messages)

		expect(outputValue(toolResult!)).toContain('hello')
		expect(awareness.getLocalState()?.presence).toMatchObject({ currentFile: '/notes.txt', action: 'reading' })
		expect(fs.getLocalSelection('/notes.txt')).toEqual({ anchor: 0, head: 'hello\nworld'.length })
	})

	test('edit hook sets editResult and selects affected lines', async () => {
		const { fs, awareness } = createFsWithAwareness()
		fs.createFile('/notes.txt', 'alpha\nbeta\ngamma')
		const editTool = createYjsFsEditTool(fs)
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('edit', {
					file_path: '/notes.txt',
					old_string: 'beta',
					new_string: 'BETA',
					replace_all: false,
				}),
				assistantText('Done.'),
			]),
			tools: { edit: editTool },
			hooks: { postToolUse: createYjsFsPresenceHooks(fs, { selectionFadeMs: 60_000 }) },
		})

		await agent.run({ state: startState([userMessage('edit it')]) }).result

		expect(awareness.getLocalState()?.presence).toMatchObject({ currentFile: '/notes.txt', action: 'editing' })
		expect((awareness.getLocalState()?.presence as { editResult?: unknown }).editResult).toBeDefined()
		expect(fs.getLocalSelection('/notes.txt')).toEqual({ anchor: 6, head: 10 })
	})

	test('write hook sets current file and writing action', async () => {
		const { fs, awareness } = createFsWithAwareness()
		const writeTool = createYjsFsWriteTool(fs)
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('write', { file_path: '/created.txt', content: 'new file' }),
				assistantText('Done.'),
			]),
			tools: { write: writeTool },
			hooks: { postToolUse: createYjsFsPresenceHooks(fs, { selectionFadeMs: 60_000 }) },
		})

		await agent.run({ state: startState([userMessage('write it')]) }).result

		expect(awareness.getLocalState()?.presence).toMatchObject({ currentFile: '/created.txt', action: 'writing' })
		expect(fs.getLocalSelection('/created.txt')).toEqual({ anchor: 0, head: 'new file'.length })
	})

	test('apply patch hook sets patched file and patching action', async () => {
		const { fs, awareness } = createFsWithAwareness()
		fs.createFile('/notes.txt', 'one\ntwo\n')
		const applyPatchTool = createYjsFsApplyPatchTool(fs)
		const patchText = `*** Begin Patch
*** Update File: /notes.txt
@@
 one
-two
+TWO
*** End Patch`
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('apply_patch', { patch_text: patchText }), assistantText('Done.')]),
			tools: { apply_patch: applyPatchTool },
			hooks: { postToolUse: createYjsFsPresenceHooks(fs, { selectionFadeMs: 60_000 }) },
		})

		await agent.run({ state: startState([userMessage('patch it')]) }).result

		expect(awareness.getLocalState()?.presence).toMatchObject({ currentFile: '/notes.txt', action: 'patching' })
	})

	test('delete hook sets deleting action and clears selection', async () => {
		const { fs, awareness } = createFsWithAwareness()
		fs.createFile('/notes.txt', 'content')
		fs.setLocalSelection('/notes.txt', 0, 3)
		const deleteTool = DeleteFileTool.define(async (input) => {
			fs.unlink(input.file_path)
			return `Deleted ${input.file_path}`
		})
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('delete_file', { file_path: '/notes.txt' }),
				assistantText('Done.'),
			]),
			tools: { delete_file: deleteTool },
			hooks: { postToolUse: createYjsFsPresenceHooks(fs, { selectionFadeMs: 60_000 }) },
		})

		await agent.run({ state: startState([userMessage('delete it')]) }).result

		expect(awareness.getLocalState()?.presence).toMatchObject({ currentFile: '/notes.txt', action: 'deleting' })
		expect(awareness.getLocalState()?.selection).toBeNull()
	})

	test('selection fades after configured timeout', async () => {
		const { fs, awareness } = createFsWithAwareness()
		fs.createFile('/notes.txt', 'content')
		const readTool = createYjsFsReadTool(fs)
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('read', { file_path: '/notes.txt' }), assistantText('Done.')]),
			tools: { read: readTool },
			hooks: { postToolUse: createYjsFsPresenceHooks(fs, { selectionFadeMs: 5 }) },
		})

		await agent.run({ state: startState([userMessage('read it')]) }).result
		expect(awareness.getLocalState()?.selection).toBeDefined()
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(awareness.getLocalState()?.selection).toBeNull()
	})

	test('hooks no-op gracefully when filesystem has no awareness', async () => {
		const fs = new YjsFilesystem({ doc: new Y.Doc(), awareness: null })
		fs.createFile('/notes.txt', 'content')
		const readTool = createYjsFsReadTool(fs)
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('read', { file_path: '/notes.txt' }), assistantText('Done.')]),
			tools: { read: readTool },
			hooks: { postToolUse: createYjsFsPresenceHooks(fs, { selectionFadeMs: 5 }) },
		})

		const result = await agent.run({ state: startState([userMessage('read it')]) }).result

		const [toolResult] = getToolResults(result.state.messages)
		expect(outputValue(toolResult!)).toContain('content')
	})
})
