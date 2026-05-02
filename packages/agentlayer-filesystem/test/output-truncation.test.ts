import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Agent, BashTool, GlobTool, GrepTool, ListTool, startState } from '@humanlayer/agentlayer-core'
import {
	bashOutputTruncationHook,
	createBashOutputTruncationHook,
	createGlobOutputTruncationHook,
	createGrepOutputTruncationHook,
	createListOutputTruncationHook,
	globOutputTruncationHook,
	grepOutputTruncationHook,
	listOutputTruncationHook,
	saneDefaultOutputTruncationHooks,
	saveFullOutput,
} from '../src/hooks'
import { assistantText, assistantWithToolCall, getToolResults, mockModel, outputValue, userMessage } from './mocks'

async function runToolWithHook(toolName: string, tool: any, hook: any, input: Record<string, unknown> = {}) {
	const agent = new Agent({
		model: mockModel([assistantWithToolCall(toolName, input), assistantText('Done.')]),
		tools: { [toolName]: tool },
		hooks: { postToolUse: [hook] },
	})
	const result = await agent.run({ state: startState([userMessage('go')]) }).result
	const [toolResult] = getToolResults(result.state.messages)
	return outputValue(toolResult!)
}

function extractSavedPath(output: string): string {
	const match = output.match(/Full output saved to ([^)]+)/)
	expect(match).toBeTruthy()
	return match![1]!
}

describe('saveFullOutput', () => {
	test('creates temp output file with exact content', async () => {
		const filePath = await saveFullOutput('line one\nline two')
		expect(dirname(filePath)).toContain('agent-tool-output-')
		expect(filePath.endsWith('/output.txt')).toBe(true)
		expect(await readFile(filePath, 'utf8')).toBe('line one\nline two')
	})
})

describe('disk-backed output truncation hooks — pass through', () => {
	test('bash output under limits is unchanged', async () => {
		const tool = BashTool.define(async () => 'short output')
		const output = await runToolWithHook('bash', tool, createBashOutputTruncationHook({ maxLines: 10 }))
		expect(output).toBe('short output')
		expect(output).not.toContain('Full output saved')
	})

	test('glob output under limits is unchanged', async () => {
		const tool = GlobTool.define(async () => ['a.ts', 'b.ts'])
		const output = await runToolWithHook('glob', tool, createGlobOutputTruncationHook({ maxLines: 10 }), {
			pattern: '**/*.ts',
		})
		expect(output).toBe('a.ts\nb.ts')
		expect(output).not.toContain('Full output saved')
	})
})

describe('disk-backed output truncation hooks — truncation', () => {
	test('bash truncates from tail and saves full output', async () => {
		const tool = BashTool.define(async () => Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n'))
		const output = await runToolWithHook('bash', tool, createBashOutputTruncationHook({ maxLines: 2 }))
		const savedPath = extractSavedPath(output)
		expect(output).toContain('line 4\nline 5')
		expect(output).not.toContain('line 1\nline 2')
		expect(await readFile(savedPath, 'utf8')).toContain('line 1\nline 2\nline 3\nline 4\nline 5')
	})

	test('glob truncates from head and saves full output', async () => {
		const tool = GlobTool.define(async () => ['a.ts', 'b.ts', 'c.ts', 'd.ts'])
		const output = await runToolWithHook('glob', tool, createGlobOutputTruncationHook({ maxLines: 2 }), {
			pattern: '**/*.ts',
		})
		const savedPath = extractSavedPath(output)
		expect(output).toContain('a.ts\nb.ts')
		expect(output).not.toContain('c.ts\nd.ts')
		expect(await readFile(savedPath, 'utf8')).toBe('a.ts\nb.ts\nc.ts\nd.ts')
	})

	test('grep truncates from head and saves full output', async () => {
		const tool = GrepTool.define(async () => [
			{ file: 'a.ts', line: 1, content: 'match one' },
			{ file: 'a.ts', line: 2, content: 'match two' },
			{ file: 'a.ts', line: 3, content: 'match three' },
		])
		const output = await runToolWithHook('grep', tool, createGrepOutputTruncationHook({ maxLines: 2 }), {
			pattern: 'match',
		})
		const savedPath = extractSavedPath(output)
		expect(output).toContain('match one')
		expect(output).not.toContain('match three')
		expect(await readFile(savedPath, 'utf8')).toContain('match three')
	})

	test('list truncates from head and saves full output', async () => {
		const tool = ListTool.define(async () => [
			{ name: 'a.ts', type: 'file' },
			{ name: 'b.ts', type: 'file' },
			{ name: 'src', type: 'directory' },
		])
		const output = await runToolWithHook('list', tool, createListOutputTruncationHook({ maxLines: 2 }))
		const savedPath = extractSavedPath(output)
		expect(output).toContain('a.ts')
		expect(output).not.toContain('src')
		expect(await readFile(savedPath, 'utf8')).toContain('src')
	})
})

describe('disk-backed output truncation hooks — custom hints and defaults', () => {
	test('uses custom hint function', async () => {
		const tool = GlobTool.define(async () => ['a.ts', 'b.ts', 'c.ts'])
		const output = await runToolWithHook(
			'glob',
			tool,
			createGlobOutputTruncationHook({
				maxLines: 1,
				hint: ({ toolName, outputPath }) => `CUSTOM ${toolName}: ${outputPath}`,
			}),
			{ pattern: '**/*.ts' },
		)
		expect(output).toContain('CUSTOM glob:')
	})

	test('exports pre-composed hooks and sane defaults', () => {
		expect(bashOutputTruncationHook).toBeFunction()
		expect(globOutputTruncationHook).toBeFunction()
		expect(grepOutputTruncationHook).toBeFunction()
		expect(listOutputTruncationHook).toBeFunction()
		expect(saneDefaultOutputTruncationHooks).toHaveLength(5)
	})
})
