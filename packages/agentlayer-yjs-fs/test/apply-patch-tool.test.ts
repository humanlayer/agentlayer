import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { createYjsFsApplyPatchTool, createYjsFsEditTool, createYjsFsReadTool, createYjsFsWriteTool } from '../src/tools'
import { createSyncedYjsFilesystems, makeToolContext } from './mocks'

describe('createYjsFsApplyPatchTool', () => {
	test('applies unified update patch to file', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/test.ts', 'const x = 1\nconst y = 2\n')
		const tool = createYjsFsApplyPatchTool(fs)

		const result = await tool.execute(
			{
				patch_text: `*** Begin Patch
*** Update File: /test.ts
@@
 const x = 1
-const y = 2
+const y = 3
*** End Patch`,
			},
			makeToolContext(),
		)

		expect(result).toBe('Updated /test.ts')
		expect(fs.readFile('/test.ts')).toBe('const x = 1\nconst y = 3\n')
	})

	test('handles multi-file patches', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/a.ts', 'a\n')
		fs.createFile('/b.ts', 'b\n')
		const tool = createYjsFsApplyPatchTool(fs)

		const result = await tool.execute(
			{
				patch_text: `*** Begin Patch
*** Update File: /a.ts
@@
-a
+a1
*** Update File: /b.ts
@@
-b
+b1
*** End Patch`,
			},
			makeToolContext(),
		)

		expect(result).toBe('Updated /a.ts\nUpdated /b.ts')
		expect(fs.readFile('/a.ts')).toBe('a1\n')
		expect(fs.readFile('/b.ts')).toBe('b1\n')
	})

	test('adds files and creates parent directories', async () => {
		const fs = new YjsFilesystem()
		const tool = createYjsFsApplyPatchTool(fs)

		await tool.execute(
			{
				patch_text: `*** Begin Patch
*** Add File: /src/new.ts
+export const value = 1
*** End Patch`,
			},
			makeToolContext(),
		)

		expect(fs.readFile('/src/new.ts')).toBe('export const value = 1\n')
	})

	test('throws error for malformed patch', async () => {
		const tool = createYjsFsApplyPatchTool(new YjsFilesystem())

		await expect(tool.execute({ patch_text: 'not a patch' }, makeToolContext())).rejects.toThrow(
			'Invalid patch format',
		)
	})

	test('throws error for patch that does not apply cleanly', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/test.ts', 'actual\n')
		const tool = createYjsFsApplyPatchTool(fs)

		await expect(
			tool.execute(
				{
					patch_text: `*** Begin Patch
*** Update File: /test.ts
@@
-expected
+updated
*** End Patch`,
				},
				makeToolContext(),
			),
		).rejects.toThrow('apply_patch verification failed')
	})

	test('syncs write, edit, and patch operations through Yjs document updates', async () => {
		const { fsA, fsB, syncBothWays } = createSyncedYjsFilesystems()
		const writeA = createYjsFsWriteTool(fsA)
		const editB = createYjsFsEditTool(fsB)
		const patchA = createYjsFsApplyPatchTool(fsA)
		const readB = createYjsFsReadTool(fsB)

		await writeA.execute({ file_path: '/test.ts', content: 'const x = 1\nconst y = 2\n' }, makeToolContext())
		syncBothWays()

		await editB.execute(
			{ file_path: '/test.ts', old_string: 'const y = 2', new_string: 'const y = 3', replace_all: false },
			makeToolContext(),
		)
		syncBothWays()

		await patchA.execute(
			{
				patch_text: `*** Begin Patch
*** Update File: /test.ts
@@
 const x = 1
-const y = 3
+const y = 4
*** End Patch`,
			},
			makeToolContext(),
		)
		syncBothWays()

		const expected = 'const x = 1\nconst y = 4\n'
		expect(await readB.execute({ file_path: '/test.ts', limit: 2000 }, makeToolContext())).toBe(expected)
		expect(fsA.getYText('/test.ts').toString()).toBe(expected)
		expect(fsB.getYText('/test.ts').toString()).toBe(expected)
	})
})
