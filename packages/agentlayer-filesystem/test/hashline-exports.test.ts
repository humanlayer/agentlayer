import { describe, expect, test } from 'bun:test'
import { createHashlineFilesystemToolset } from '../src/coding-agent'
import { createHashlineEditTool, createHashReadTool } from '../src/tools'

describe('hashline exports', () => {
	test('hashline tools use classic public names', () => {
		expect(createHashReadTool().name).toBe('read')
		expect(createHashlineEditTool().name).toBe('edit')
	})

	test('hashline toolset exports read and edit tools', () => {
		const [read, edit] = createHashlineFilesystemToolset()
		expect(read.name).toBe('read')
		expect(edit.name).toBe('edit')
	})

	test('bun condition resolves hashline source exports', async () => {
		const core = await import('@humanlayer/agentlayer-core/interfaces')
		const filesystem = await import('@humanlayer/agentlayer-filesystem/tools')
		expect(core.HashReadTool.name).toBe('read')
		expect(core.HashlineEditTool.name).toBe('edit')
		expect(filesystem.createHashReadTool().name).toBe('read')
		expect(filesystem.createHashlineEditTool().name).toBe('edit')
	})
})
