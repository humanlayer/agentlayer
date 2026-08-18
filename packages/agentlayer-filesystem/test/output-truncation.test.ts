import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
	Agent,
	BashTool,
	GlobTool,
	GrepTool,
	ListTool,
	startState,
	WebFetchTool,
	WebSearchTool,
} from '@humanlayer/agentlayer-core'
import {
	bashOutputTruncationHook,
	createBashOutputTruncationHook,
	createGlobOutputTruncationHook,
	createGrepOutputTruncationHook,
	createListOutputTruncationHook,
	createWebOutputTruncationHook,
	globOutputTruncationHook,
	grepOutputTruncationHook,
	listOutputTruncationHook,
	saneDefaultOutputTruncationHooks,
	saveFullOutput,
	webOutputTruncationHook,
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

function extractWebSavedPath(output: string): string {
	const match = output.match(/Full output saved to (.+?)\. (?:Showing lines|The first line)/)
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

describe('web output truncation hook', () => {
	test('preserves under-limit web fetch and search results registered under model-facing names', async () => {
		const hook = createWebOutputTruncationHook({ maxLines: 10, maxBytes: 100_000 })
		const fetchOutput = await runToolWithHook(
			'web_fetch',
			WebFetchTool.define(async () => 'short fetched page'),
			hook,
			{ url: 'https://example.com' },
		)
		const searchOutput = await runToolWithHook(
			'web_search',
			WebSearchTool.define(async () => ({
				results: [{ title: 'Result', url: 'https://example.com/result', snippet: 'short result' }],
			})),
			hook,
			{ query: 'example' },
		)

		expect(fetchOutput).toBe('short fetched page')
		expect(searchOutput).toBe('Result\n  https://example.com/result\n  short result')
		expect(fetchOutput).not.toContain('Full output saved')
		expect(searchOutput).not.toContain('Full output saved')
	})

	test('keeps a head excerpt, saves the complete fetch result, and provides a read offset', async () => {
		const fullOutput = 'first line\nsecond line\nthird line\nfourth line'
		const output = await runToolWithHook(
			'web_fetch',
			WebFetchTool.define(async () => fullOutput),
			createWebOutputTruncationHook({ maxLines: 2, maxBytes: 100_000 }),
			{ url: 'https://example.com' },
		)
		const savedPath = extractWebSavedPath(output)

		expect(output).toContain('first line\nsecond line')
		expect(output).not.toContain('third line')
		expect(output).toContain('Showing lines 1-2')
		expect(output).toContain(`read(file_path="${savedPath}", offset=3)`)
		expect(await readFile(savedPath, 'utf8')).toBe(fullOutput)
	})

	test('truncates serialized web search output from the head', async () => {
		const output = await runToolWithHook(
			'web_search',
			WebSearchTool.define(async () => ({
				results: [
					{ title: 'First', url: 'https://example.com/first', snippet: 'first snippet' },
					{ title: 'Second', url: 'https://example.com/second', snippet: 'second snippet' },
				],
			})),
			createWebOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 }),
			{ query: 'example' },
		)

		expect(output).toContain('First\n  https://example.com/first\n  first snippet')
		expect(output).not.toContain('Second')
		expect(await readFile(extractWebSavedPath(output), 'utf8')).toContain('Second')
	})

	test('does not affect non-web tools', async () => {
		const output = await runToolWithHook(
			'bash',
			BashTool.define(async () => 'first line\nsecond line'),
			createWebOutputTruncationHook({ maxLines: 1, maxBytes: 1 }),
			{ command: 'echo test', timeout: 5000 },
		)

		expect(output).toBe('first line\nsecond line')
		expect(output).not.toContain('Full output saved')
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
		expect(webOutputTruncationHook).toBeFunction()
		expect(saneDefaultOutputTruncationHooks).toHaveLength(6)
	})
})
