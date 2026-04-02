import { describe, expect, test } from 'bun:test'
import { CodeSearchTool, codeSearchInput } from '../src/tools/interfaces/code-search'
import { WebSearchTool, webSearchInput } from '../src/tools/interfaces/web-search'
import { createCodeSearchTool } from '../src/tools/server/code-search'
import { createWebSearchTool } from '../src/tools/server/web-search'
import { makeToolContext } from './mocks'

// ─── WebSearch Interface ──────────────────────────────────────────────────────

describe('WebSearchTool interface', () => {
	test('has correct name "websearch"', () => {
		expect(WebSearchTool.name).toBe('websearch')
	})

	test('has non-empty description', () => {
		expect(WebSearchTool.description.length).toBeGreaterThan(0)
	})

	test('define() returns a tool with name "websearch"', () => {
		const tool = WebSearchTool.define(async () => ({ results: [] }))
		expect(tool.name).toBe('websearch')
	})
})

// ─── WebSearch Schema ─────────────────────────────────────────────────────────

describe('webSearchInput schema', () => {
	test('requires query', () => {
		const result = webSearchInput.safeParse({})
		expect(result.success).toBe(false)
	})

	test('parses valid input with query only', () => {
		const result = webSearchInput.safeParse({ query: 'typescript generics' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.query).toBe('typescript generics')
			expect(result.data.numResults).toBe(5)
		}
	})

	test('numResults defaults to 5', () => {
		const result = webSearchInput.safeParse({ query: 'test' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.numResults).toBe(5)
		}
	})

	test('accepts custom numResults', () => {
		const result = webSearchInput.safeParse({ query: 'test', numResults: 10 })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.numResults).toBe(10)
		}
	})
})

// ─── WebSearch Serialize ──────────────────────────────────────────────────────

describe('WebSearchTool serialize', () => {
	test('empty results returns "No results found."', async () => {
		const tool = WebSearchTool.define(async () => ({ results: [] }))
		const input = { query: 'something', numResults: 5 }
		const raw = await tool.execute(input, makeToolContext())
		const output = tool.serialize!(raw as any, input)
		expect(output).toBe('No results found.')
	})

	test('formats results with title, url, snippet', async () => {
		const tool = WebSearchTool.define(async () => ({
			results: [
				{
					title: 'TypeScript Docs',
					url: 'https://typescriptlang.org',
					snippet: 'Official TypeScript documentation',
				},
			],
		}))
		const input = { query: 'typescript', numResults: 5 }
		const raw = await tool.execute(input, makeToolContext())
		const output = tool.serialize!(raw as any, input)
		expect(output).toContain('TypeScript Docs')
		expect(output).toContain('https://typescriptlang.org')
		expect(output).toContain('Official TypeScript documentation')
	})

	test('formats multiple results separated by blank lines', async () => {
		const tool = WebSearchTool.define(async () => ({
			results: [
				{ title: 'Result 1', url: 'https://example.com/1', snippet: 'First result' },
				{ title: 'Result 2', url: 'https://example.com/2', snippet: 'Second result' },
			],
		}))
		const input = { query: 'test', numResults: 5 }
		const raw = await tool.execute(input, makeToolContext())
		const output = tool.serialize!(raw as any, input)
		expect(output).toContain('Result 1')
		expect(output).toContain('Result 2')
		// Results should be separated
		expect(output.indexOf('Result 1')).toBeLessThan(output.indexOf('Result 2'))
	})

	test('result format: title on first line, url indented, snippet indented', async () => {
		const tool = WebSearchTool.define(async () => ({
			results: [{ title: 'My Title', url: 'https://my.url', snippet: 'My snippet text' }],
		}))
		const input = { query: 'test', numResults: 5 }
		const raw = await tool.execute(input, makeToolContext())
		const output = tool.serialize!(raw as any, input)
		const lines = output.split('\n')
		expect(lines[0]).toBe('My Title')
		expect(lines[1]).toBe('  https://my.url')
		expect(lines[2]).toBe('  My snippet text')
	})
})

// ─── CodeSearch Interface ─────────────────────────────────────────────────────

describe('CodeSearchTool interface', () => {
	test('has correct name "codesearch"', () => {
		expect(CodeSearchTool.name).toBe('codesearch')
	})

	test('has non-empty description', () => {
		expect(CodeSearchTool.description.length).toBeGreaterThan(0)
	})

	test('define() returns a tool with name "codesearch"', () => {
		const tool = CodeSearchTool.define(async () => 'docs content')
		expect(tool.name).toBe('codesearch')
	})
})

// ─── CodeSearch Schema ────────────────────────────────────────────────────────

describe('codeSearchInput schema', () => {
	test('requires query', () => {
		const result = codeSearchInput.safeParse({ packageName: 'zod' })
		expect(result.success).toBe(false)
	})

	test('requires packageName', () => {
		const result = codeSearchInput.safeParse({ query: 'how to validate' })
		expect(result.success).toBe(false)
	})

	test('requires both query and packageName', () => {
		const result = codeSearchInput.safeParse({})
		expect(result.success).toBe(false)
	})

	test('parses valid input', () => {
		const result = codeSearchInput.safeParse({ query: 'how to validate', packageName: 'zod' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.query).toBe('how to validate')
			expect(result.data.packageName).toBe('zod')
			expect(result.data.language).toBe('typescript')
		}
	})

	test('language defaults to "typescript"', () => {
		const result = codeSearchInput.safeParse({ query: 'test', packageName: 'zod' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.language).toBe('typescript')
		}
	})

	test('accepts custom language', () => {
		const result = codeSearchInput.safeParse({ query: 'test', packageName: 'numpy', language: 'python' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.language).toBe('python')
		}
	})
})

// ─── Factory validation ───────────────────────────────────────────────────────

describe('createWebSearchTool factory', () => {
	test('returns a Tool object when valid opts provided', () => {
		const tool = createWebSearchTool({ exaApiKey: 'test-key' })
		expect(tool.name).toBe('websearch')
		expect(typeof tool.execute).toBe('function')
	})
})

describe('createCodeSearchTool factory', () => {
	test('throws when no API keys provided', () => {
		expect(() => createCodeSearchTool({})).toThrow('At least one API key')
	})

	test('throws with descriptive message when no keys', () => {
		expect(() => createCodeSearchTool({})).toThrow('exaApiKey or context7ApiKey')
	})

	test('does not throw when exaApiKey is provided', () => {
		expect(() => createCodeSearchTool({ exaApiKey: 'test-key' })).not.toThrow()
	})

	test('does not throw when context7ApiKey is provided', () => {
		expect(() => createCodeSearchTool({ context7ApiKey: 'test-key' })).not.toThrow()
	})

	test('does not throw when both keys are provided', () => {
		expect(() => createCodeSearchTool({ exaApiKey: 'test-key', context7ApiKey: 'c7-key' })).not.toThrow()
	})

	test('returns a Tool object with correct name', () => {
		const tool = createCodeSearchTool({ exaApiKey: 'test-key' })
		expect(tool.name).toBe('codesearch')
		expect(typeof tool.execute).toBe('function')
	})
})

// ─── Live integration tests (skipped without API keys) ────────────────────────

describe.skip('WebSearch — live Exa integration', () => {
	test.skipIf(!process.env.EXA_API_KEY || !!process.env.CI)('live Exa search returns results', async () => {
		const tool = createWebSearchTool({ exaApiKey: process.env.EXA_API_KEY! })
		const raw = await tool.execute({ query: 'typescript zod schema validation', numResults: 3 }, makeToolContext())
		const result = raw as { results: Array<{ title: string; url: string; snippet: string }> }
		expect(result.results.length).toBeGreaterThan(0)
		expect(result.results[0]).toHaveProperty('title')
		expect(result.results[0]).toHaveProperty('url')
	})
})

describe('CodeSearch — live integration', () => {
	test.skipIf(!process.env.EXA_API_KEY || !!process.env.CI)('live Exa code search returns docs', async () => {
		const tool = createCodeSearchTool({ exaApiKey: process.env.EXA_API_KEY! })
		const raw = await tool.execute(
			{ query: 'how to define a schema', packageName: 'zod', language: 'typescript' },
			makeToolContext(),
		)
		expect(typeof raw).toBe('string')
		expect((raw as string).length).toBeGreaterThan(0)
	})

	test.skipIf(!process.env.CONTEXT7_API_KEY || !!process.env.CI)(
		'live Context7 code search returns docs',
		async () => {
			const tool = createCodeSearchTool({ context7ApiKey: process.env.CONTEXT7_API_KEY! })
			const raw = await tool.execute(
				{ query: 'how to define a schema', packageName: 'zod', language: 'typescript' },
				makeToolContext(),
			)
			expect(typeof raw).toBe('string')
			expect((raw as string).length).toBeGreaterThan(0)
		},
	)
})
