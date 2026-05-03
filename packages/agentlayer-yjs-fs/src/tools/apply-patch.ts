import { dirname, isAbsolute, resolve } from 'node:path/posix'
import { ApplyPatchTool } from '@humanlayer/agentlayer-core/interfaces'
import { APPLY_PATCH_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import { applyUpdateChunks, type PatchOperation, parsePatch, validateHunks } from '@humanlayer/agentlayer-core/utils'
import type { YjsFilesystem } from '@humanlayer/yjs-fs'

export interface YjsFsApplyPatchOptions {
	cwd?: string
}

function ensureParentDirectories(fs: YjsFilesystem, filePath: string): void {
	const parent = dirname(filePath)
	if (parent === '.' || parent === '/' || fs.exists(parent)) return
	ensureParentDirectories(fs, parent)
	fs.mkdir(parent)
}

export function createYjsFsApplyPatchTool(fs: YjsFilesystem, opts: YjsFsApplyPatchOptions = {}) {
	const resolvePath = (filePath: string): string => {
		if (!opts.cwd || isAbsolute(filePath)) return filePath
		return resolve(opts.cwd, filePath)
	}

	return ApplyPatchTool.define(
		async (input) => {
			if (!input.patch_text || !input.patch_text.trim()) {
				throw new Error('patch_text is required')
			}

			let ops: PatchOperation[]
			try {
				ops = parsePatch(input.patch_text)
			} catch (err) {
				throw new Error(`apply_patch verification failed: ${err}`)
			}

			if (ops.length === 0) throw new Error('patch rejected: empty patch')
			const hasHunks = ops.some((op) => op.type === 'add' || op.chunks.length > 0 || op.type === 'delete')
			if (!hasHunks) throw new Error('apply_patch verification failed: no hunks found')

			const readExistingFile = async (filePath: string): Promise<string> => {
				try {
					return fs.readFile(resolvePath(filePath))
				} catch {
					throw new Error(`File not found: ${filePath}`)
				}
			}

			await validateHunks(ops, readExistingFile)

			const results: string[] = []
			for (const op of ops) {
				if (op.type === 'add') {
					const filePath = resolvePath(op.filePath)
					ensureParentDirectories(fs, filePath)
					const addContent = op.addContent ?? ''
					const content =
						addContent.length === 0 || addContent.endsWith('\n') ? addContent : `${addContent}\n`
					fs.createFile(filePath, content)
					results.push(`Added ${op.filePath}`)
				} else if (op.type === 'update') {
					const filePath = resolvePath(op.filePath)
					const content = await readExistingFile(op.filePath)
					fs.writeFile(filePath, applyUpdateChunks(content, op.chunks))
					results.push(`Updated ${op.filePath}`)
				} else if (op.type === 'move') {
					const filePath = resolvePath(op.filePath)
					const targetPath = resolvePath(op.targetPath!)
					ensureParentDirectories(fs, targetPath)
					const content = await readExistingFile(op.filePath)
					fs.createFile(targetPath, applyUpdateChunks(content, op.chunks))
					fs.unlink(filePath)
					results.push(`Moved ${op.filePath} -> ${op.targetPath}`)
				} else if (op.type === 'delete') {
					fs.unlink(resolvePath(op.filePath))
					results.push(`Deleted ${op.filePath}`)
				}
			}

			return results.join('\n')
		},
		{ description: APPLY_PATCH_DESCRIPTION },
	)
}
