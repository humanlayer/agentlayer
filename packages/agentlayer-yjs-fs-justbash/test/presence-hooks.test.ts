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
import { createYjsFsBashPresenceHooks } from '../src/hooks'
import { createYjsFsBashTool } from '../src/tools/bash'

function createFsWithAwareness() {
	const doc = new Y.Doc()
	const awareness = new Awareness(doc)
	const fs = new YjsFilesystem({ doc, awareness })
	return { fs, awareness }
}

describe('createYjsFsBashPresenceHooks', () => {
	test('sets presence and selection for bash-written files', async () => {
		const { fs, awareness } = createFsWithAwareness()
		const bashTool = createYjsFsBashTool(fs)
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo hello > /notes.txt', timeout: 120000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: createYjsFsBashPresenceHooks(fs, { selectionFadeMs: 60_000 }) },
		})

		const result = await agent.run({ state: startState([userMessage('write it')]) }).result
		const [toolResult] = getToolResults(result.state.messages)

		expect(outputValue(toolResult!)).toContain('Exit code: 0')
		expect(awareness.getLocalState()?.presence).toMatchObject({ currentFile: '/notes.txt', action: 'writing' })
		expect(fs.getLocalSelection('/notes.txt')).toEqual({ anchor: 0, head: 'hello\n'.length })
	})

	test('sets listing presence for bash directory reads', async () => {
		const { fs, awareness } = createFsWithAwareness()
		fs.createFile('/notes.txt', 'hello')
		const bashTool = createYjsFsBashTool(fs)
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'ls /', timeout: 120000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: createYjsFsBashPresenceHooks(fs, { selectionFadeMs: 60_000 }) },
		})

		await agent.run({ state: startState([userMessage('list it')]) }).result

		expect(awareness.getLocalState()?.presence).toMatchObject({ currentFile: '/', action: 'listing' })
	})
})
