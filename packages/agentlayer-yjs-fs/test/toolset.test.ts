import { describe, expect, test } from 'bun:test'
import { Agent, startState } from '@humanlayer/agentlayer-core'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { createYjsFsToolset } from '../src'
import {
	assistantText,
	assistantWithToolCall,
	getToolResults,
	makeToolContext,
	mockModel,
	outputValue,
	userMessage,
} from './mocks'

describe('createYjsFsToolset', () => {
	test('creates a new YjsFilesystem when called with no args', () => {
		const toolset = createYjsFsToolset()

		expect(toolset.fs).toBeInstanceOf(YjsFilesystem)
		expect(Object.keys(toolset.tools).sort()).toEqual([
			'apply_patch',
			'edit',
			'glob',
			'grep',
			'list',
			'read',
			'write',
		])
		expect(toolset.hooks.postToolUse.length).toBeGreaterThan(0)
	})

	test('uses provided YjsFilesystem unchanged when fs is passed', async () => {
		const fs = new YjsFilesystem()
		const toolset = createYjsFsToolset({ fs })

		expect(toolset.fs).toBe(fs)
		await toolset.tools.write.execute({ file_path: '/notes.txt', content: 'hello' }, makeToolContext())
		expect(fs.readFile('/notes.txt')).toBe('hello')
	})

	test('constructs YjsFilesystem with provided doc and awareness', async () => {
		const doc = new Y.Doc()
		const awareness = new Awareness(doc)
		const toolset = createYjsFsToolset({ doc, awareness })

		expect(toolset.fs.doc).toBe(doc)
		expect(toolset.fs.awareness).toBe(awareness)

		await toolset.tools.write.execute({ file_path: '/from-doc.txt', content: 'synced' }, makeToolContext())
		const secondFs = new YjsFilesystem({ doc })
		expect(secondFs.readFile('/from-doc.txt')).toBe('synced')
	})

	test('returns all tools bound to the same filesystem instance', async () => {
		const toolset = createYjsFsToolset()

		await toolset.tools.write.execute({ file_path: '/src/app.ts', content: 'const value = 1\n' }, makeToolContext())
		const readOutput = await toolset.tools.read.execute(
			{ file_path: '/src/app.ts', limit: 2000 },
			makeToolContext(),
		)
		const globOutput = await toolset.tools.glob.execute({ pattern: '**/*.ts' }, makeToolContext())
		const grepOutput = await toolset.tools.grep.execute({ pattern: 'value' }, makeToolContext())
		const listOutput = await toolset.tools.list.execute({ path: '/src' }, makeToolContext())

		expect(readOutput).toBe('const value = 1\n')
		expect(globOutput).toEqual(['/src/app.ts'])
		expect(grepOutput).toEqual([{ file: '/src/app.ts', line: 1, content: 'const value = 1' }])
		expect(listOutput).toEqual([{ name: '/src/app.ts', type: 'file' }])
	})

	test('presence hooks update awareness when awareness is provided', async () => {
		const doc = new Y.Doc()
		const awareness = new Awareness(doc)
		const toolset = createYjsFsToolset({ doc, awareness, presence: { selectionFadeMs: 60_000 } })
		toolset.fs.createFile('/notes.txt', 'content')
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('read', { file_path: '/notes.txt' }), assistantText('Done.')]),
			tools: { read: toolset.tools.read },
			hooks: toolset.hooks,
		})

		const result = await agent.run({ state: startState([userMessage('read it')]) }).result
		const [toolResult] = getToolResults(result.state.messages)

		expect(outputValue(toolResult!)).toContain('content')
		expect(awareness.getLocalState()?.presence).toMatchObject({ currentFile: '/notes.txt', action: 'reading' })
		expect(toolset.fs.getLocalSelection('/notes.txt')).toEqual({ anchor: 0, head: 'content'.length })
	})

	test('presence hooks no-op without awareness and update after awareness is attached', async () => {
		const toolset = createYjsFsToolset()
		toolset.fs.createFile('/notes.txt', 'content')
		const agentWithoutAwareness = new Agent({
			model: mockModel([assistantWithToolCall('read', { file_path: '/notes.txt' }), assistantText('Done.')]),
			tools: { read: toolset.tools.read },
			hooks: toolset.hooks,
		})

		await agentWithoutAwareness.run({ state: startState([userMessage('read it')]) }).result

		const awareness = new Awareness(toolset.fs.doc)
		toolset.fs.setAwareness(awareness)
		const agentWithAwareness = new Agent({
			model: mockModel([assistantWithToolCall('read', { file_path: '/notes.txt' }), assistantText('Done.')]),
			tools: { read: toolset.tools.read },
			hooks: toolset.hooks,
		})

		await agentWithAwareness.run({ state: startState([userMessage('read it again')]) }).result

		expect(awareness.getLocalState()?.presence).toMatchObject({ currentFile: '/notes.txt', action: 'reading' })
		expect(toolset.fs.getLocalSelection('/notes.txt')).toEqual({ anchor: 0, head: 'content'.length })
	})
})
