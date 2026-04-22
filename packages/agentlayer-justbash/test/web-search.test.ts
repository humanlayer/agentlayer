import { describe, expect, test } from 'bun:test'
import { WebSearchTool, webSearchInput } from '@humanlayer/agentlayer-core/interfaces'
import { createWebSearchTool } from '../src/tools/web-search'
import { makeToolContext } from './mocks'

describe('WebSearchTool interface', () => {
	test('has correct name', () => {
		expect(WebSearchTool.name).toBe('websearch')
	})

	test('define() returns a websearch tool', () => {
		const tool = WebSearchTool.define(async () => ({ results: [] }))
		expect(tool.name).toBe('websearch')
	})
})

describe('webSearchInput schema', () => {
	test('requires query', () => {
		expect(webSearchInput.safeParse({}).success).toBe(false)
	})

	test('defaults numResults to 5', () => {
		const result = webSearchInput.safeParse({ query: 'typescript generics' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.numResults).toBe(5)
		}
	})
})

describe('WebSearchTool serialize', () => {
	test('formats empty results', async () => {
		const tool = WebSearchTool.define(async () => ({ results: [] }))
		const input = { query: 'something', numResults: 5 }
		const raw = await tool.execute(input, makeToolContext())
		expect(tool.serialize!(raw as any, input)).toBe('No results found.')
	})

	test('formats result entries', async () => {
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
})

describe('createWebSearchTool', () => {
	test('returns a tool object when given a bash client and api key', () => {
		const bash = { exec: async () => ({ exitCode: 0, stdout: '{"results":[]}', stderr: '' }) }
		const tool = createWebSearchTool(bash as any, { exaApiKey: 'test-key' })
		expect(tool.name).toBe('websearch')
		expect(typeof tool.execute).toBe('function')
	})
})
