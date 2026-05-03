import { describe, expect, test } from 'bun:test'
import { Agent, startState } from '@humanlayer/agentlayer-core'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { Awareness } from 'y-protocols/awareness.js'
import * as Y from 'yjs'
import {
	assistantText,
	assistantWithToolCall,
	getToolResults,
	mockModel,
	outputValue,
	userMessage,
} from '../../agentlayer-yjs-fs/test/mocks'
import { createYjsFsSecureExecPresenceHooks } from '../src/hooks'
import { createYjsFsSecureExecTool } from '../src/tools'

function createFsWithAwareness() {
	const doc = new Y.Doc()
	const awareness = new Awareness(doc)
	const fs = new YjsFilesystem({ doc, awareness })
	return { fs, awareness }
}

describe('createYjsFsSecureExecPresenceHooks', () => {
	test('sets presence and selection for secure-exec-written files', async () => {
		const { fs, awareness } = createFsWithAwareness()
		const execTool = createYjsFsSecureExecTool(fs)
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('secure_exec', {
					code: `import { writeFileSync } from 'node:fs'
writeFileSync('/notes.txt', 'hello')`,
					filePath: '/entry.mjs',
				}),
				assistantText('Done.'),
			]),
			tools: { secure_exec: execTool },
			hooks: { postToolUse: createYjsFsSecureExecPresenceHooks(fs, { selectionFadeMs: 60_000 }) },
		})

		const result = await agent.run({ state: startState([userMessage('write it')]) }).result
		const [toolResult] = getToolResults(result.state.messages)

		expect(outputValue(toolResult!)).toContain('"code": 0')
		expect(awareness.getLocalState()?.presence).toMatchObject({ currentFile: '/notes.txt', action: 'writing' })
		expect(fs.getLocalSelection('/notes.txt')).toEqual({ anchor: 0, head: 'hello'.length })
	})

	test('sets reading presence for secure-exec file reads', async () => {
		const { fs, awareness } = createFsWithAwareness()
		fs.createFile('/notes.txt', 'hello')
		const execTool = createYjsFsSecureExecTool(fs)
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('secure_exec', {
					code: `import { readFileSync } from 'node:fs'
readFileSync('/notes.txt', 'utf8')`,
					filePath: '/entry.mjs',
				}),
				assistantText('Done.'),
			]),
			tools: { secure_exec: execTool },
			hooks: { postToolUse: createYjsFsSecureExecPresenceHooks(fs, { selectionFadeMs: 60_000 }) },
		})

		await agent.run({ state: startState([userMessage('read it')]) }).result

		expect(awareness.getLocalState()?.presence).toMatchObject({ currentFile: '/notes.txt', action: 'reading' })
		expect(fs.getLocalSelection('/notes.txt')).toEqual({ anchor: 0, head: 'hello'.length })
	})

	test('sets listing presence for secure-exec directory reads', async () => {
		const { fs, awareness } = createFsWithAwareness()
		fs.createFile('/notes.txt', 'hello')
		const execTool = createYjsFsSecureExecTool(fs)
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('secure_exec', {
					code: `import { readdirSync } from 'node:fs'
readdirSync('/')`,
					filePath: '/entry.mjs',
				}),
				assistantText('Done.'),
			]),
			tools: { secure_exec: execTool },
			hooks: { postToolUse: createYjsFsSecureExecPresenceHooks(fs, { selectionFadeMs: 60_000 }) },
		})

		await agent.run({ state: startState([userMessage('list it')]) }).result

		expect(awareness.getLocalState()?.presence).toMatchObject({ currentFile: '/', action: 'listing' })
	})
})
