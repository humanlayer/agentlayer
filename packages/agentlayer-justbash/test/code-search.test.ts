import { describe, expect, test } from 'bun:test'
import { CodeSearchTool, codeSearchInput } from '@humanlayer/agentlayer-core/interfaces'
import { createCodeSearchTool } from '../src/tools/code-search'

describe('CodeSearchTool interface', () => {
	test('has correct name', () => {
		expect(CodeSearchTool.name).toBe('codesearch')
	})

	test('define() returns a codesearch tool', () => {
		const tool = CodeSearchTool.define(async () => 'docs')
		expect(tool.name).toBe('codesearch')
	})
})

describe('codeSearchInput schema', () => {
	test('requires both query and packageName', () => {
		expect(codeSearchInput.safeParse({}).success).toBe(false)
		expect(codeSearchInput.safeParse({ query: 'how to validate' }).success).toBe(false)
		expect(codeSearchInput.safeParse({ packageName: 'zod' }).success).toBe(false)
	})

	test('defaults language to typescript', () => {
		const result = codeSearchInput.safeParse({ query: 'how to validate', packageName: 'zod' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.language).toBe('typescript')
		}
	})
})

describe('createCodeSearchTool', () => {
	test('throws when no API keys are provided', () => {
		const bash = { exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }
		expect(() => createCodeSearchTool(bash as any, {})).toThrow('At least one API key')
	})

	test('accepts either Exa or Context7 keys', () => {
		const bash = { exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }
		expect(() => createCodeSearchTool(bash as any, { exaApiKey: 'exa' })).not.toThrow()
		expect(() => createCodeSearchTool(bash as any, { context7ApiKey: 'c7' })).not.toThrow()
	})

	test('returns a codesearch tool', () => {
		const bash = { exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }
		const tool = createCodeSearchTool(bash as any, { exaApiKey: 'exa' })
		expect(tool.name).toBe('codesearch')
	})
})
