import { beforeEach, describe, expect, test } from 'bun:test'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { z } from 'zod'
import { Agent, defineTool, startState } from '../src'
import { createPresenceHooks } from '../src/tools/y-stream-fs/presence-hooks'
import { assistantText, assistantWithToolCall, mockModel, userMessage } from './mocks'

/** Create a minimal mock fs with a Y.Doc containing a file subdoc */
function createMockFs(files: Record<string, string> = {}) {
	const doc = new Y.Doc()
	const filesMap = doc.getMap<Y.Doc>('files')
	for (const [path, content] of Object.entries(files)) {
		const subdoc = new Y.Doc()
		subdoc.getText('content').insert(0, content)
		filesMap.set(path, subdoc)
	}
	return { doc } as any
}

describe('createPresenceHooks', () => {
	let awareness: Awareness

	beforeEach(() => {
		const doc = new Y.Doc()
		awareness = new Awareness(doc)
	})

	test('returns 4 hooks (read, edit, create, delete)', () => {
		const hooks = createPresenceHooks(awareness, createMockFs())
		expect(hooks).toHaveLength(4)
	})

	test('read hook sets currentFile and action on awareness', async () => {
		const readTool = defineTool({
			name: 'read',
			description: 'Read a file',
			input: z.object({ filePath: z.string() }),
			output: z.string(),
			execute: async () => 'file contents',
		})

		const fs = createMockFs({ '/src/main.ts': 'file contents' })
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('read', { filePath: '/src/main.ts' }), assistantText('Done.')]),
			tools: { read: readTool },
			hooks: { postToolUse: createPresenceHooks(awareness, fs) },
		})

		await agent.run({ state: startState([userMessage('read a file')]) }).result

		const state = awareness.getLocalState()
		expect(state?.currentFile).toBe('/src/main.ts')
		expect(state?.action).toBe('reading')
		// Selection should be set covering the whole file
		expect(state?.selection).toBeDefined()
		expect(state?.selection?.anchor).toBeDefined()
		expect(state?.selection?.head).toBeDefined()
	})

	test('edit hook sets currentFile, action, and editResult on awareness', async () => {
		const editTool = defineTool({
			name: 'edit',
			description: 'Edit a file',
			input: z.object({
				filePath: z.string(),
				oldString: z.string(),
				newString: z.string(),
				replaceAll: z.boolean().optional().default(false),
			}),
			output: z.object({ content: z.string(), matchCount: z.number(), editResult: z.unknown().optional() }),
			execute: async () => ({
				content: 'new content',
				matchCount: 1,
				editResult: { path: '/src/main.ts', editIndex: 0, editLine: 1, affectedLines: { start: 1, end: 1 } },
			}),
		})

		const fs = createMockFs({ '/src/main.ts': 'line one\nline two\n' })
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('edit', { filePath: '/src/main.ts', oldString: 'old', newString: 'new' }),
				assistantText('Done.'),
			]),
			tools: { edit: editTool },
			hooks: { postToolUse: createPresenceHooks(awareness, fs) },
		})

		await agent.run({ state: startState([userMessage('edit a file')]) }).result

		const state = awareness.getLocalState()
		expect(state?.currentFile).toBe('/src/main.ts')
		expect(state?.action).toBe('editing')
		expect(state?.editResult).toEqual({
			path: '/src/main.ts',
			editIndex: 0,
			editLine: 1,
			affectedLines: { start: 1, end: 1 },
		})
		// Selection should be set covering affected lines
		expect(state?.selection).toBeDefined()
	})

	test('non-matching tools pass through without updating awareness', async () => {
		const bashTool = defineTool({
			name: 'bash',
			description: 'Run bash',
			input: z.object({ command: z.string() }),
			output: z.string(),
			execute: async () => 'output',
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('bash', { command: 'ls' }), assistantText('Done.')]),
			tools: { bash: bashTool },
			hooks: { postToolUse: createPresenceHooks(awareness, createMockFs()) },
		})

		await agent.run({ state: startState([userMessage('run a command')]) }).result

		const state = awareness.getLocalState()
		expect(state?.currentFile).toBeUndefined()
		expect(state?.action).toBeUndefined()
	})
})
