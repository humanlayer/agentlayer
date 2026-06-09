import { describe, expect, test } from 'bun:test'
import { Agent, startState } from '@humanlayer/agentlayer-core'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { createYjsFsReadTool } from '../src/tools'
import { assistantText, assistantWithToolCall, getToolResults, makeToolContext, mockModel, userMessage } from './mocks'

function serializeRaw<TInput, TOutput>(
	tool: { serialize?: (raw: TOutput, input: TInput) => unknown },
	raw: TOutput,
	input: TInput,
): string {
	if (tool.serialize) {
		const serialized = tool.serialize(raw, input)
		return typeof serialized === 'string' ? serialized : JSON.stringify(serialized)
	}
	return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

describe('createYjsFsReadTool', () => {
	test('agent state stores sanitized content from a text file with invalid persisted characters', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/bad.txt', 'before\0middle\uD800after')

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('read', { file_path: '/bad.txt' }), assistantText('Done.')]),
			tools: { read: createYjsFsReadTool(fs) },
		})

		const result = await agent.run({ state: startState([userMessage('read the bad file')]) }).result
		const toolResults = getToolResults(result.state.messages, { toolName: 'read' })

		expect(toolResults).toHaveLength(1)
		expect(toolResults[0]!.output.value).toContain('before\uFFFDmiddle\uFFFDafter')
		expect(toolResults[0]!.output.value).not.toContain('\0')
		expect(toolResults[0]!.output.value.isWellFormed()).toBe(true)
	})

	test('reads file content from YjsFilesystem', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/test.ts', 'const x = 1\nconst y = 2')
		const tool = createYjsFsReadTool(fs)

		const raw = await tool.execute({ file_path: '/test.ts', limit: 2000 }, makeToolContext())

		expect(raw).toBe('const x = 1\nconst y = 2')
		expect(serializeRaw(tool, raw, { file_path: '/test.ts', offset: 2, limit: 1 })).toContain('2→const y = 2')
	})

	test('applies offset and limit during serialization', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/test.ts', 'a\nb\nc\nd')
		const tool = createYjsFsReadTool(fs)

		const raw = await tool.execute({ file_path: '/test.ts', limit: 2000 }, makeToolContext())
		const serialized = serializeRaw(tool, raw, { file_path: '/test.ts', offset: 2, limit: 2 })

		expect(serialized).toContain('2→b')
		expect(serialized).toContain('3→c')
		expect(serialized).not.toContain('4→d')
	})

	test('throws error for non-existent file', async () => {
		const tool = createYjsFsReadTool(new YjsFilesystem())

		await expect(tool.execute({ file_path: '/missing.ts', limit: 2000 }, makeToolContext())).rejects.toThrow(
			'Path not found',
		)
	})

	test('throws text-file error for binary files', async () => {
		const fs = new YjsFilesystem()
		fs.createBinaryFile('/image.bin', new Uint8Array([1, 2, 3]))
		const tool = createYjsFsReadTool(fs)

		await expect(tool.execute({ file_path: '/image.bin', limit: 2000 }, makeToolContext())).rejects.toThrow(
			'not a text file',
		)
		expect(fs.readBinaryFile('/image.bin')).toEqual(new Uint8Array([1, 2, 3]))
	})
})
