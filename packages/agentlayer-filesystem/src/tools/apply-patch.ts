import { mkdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { ApplyPatchTool } from '@humanlayer/agentlayer-core/interfaces'
import { APPLY_PATCH_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import { applyUpdateChunks, type PatchOperation, parsePatch, validateHunks } from '@humanlayer/agentlayer-core/utils'

export interface ApplyPatchOptions {
	/** Working directory for resolving relative paths. If not provided, relative paths are used as-is. */
	cwd?: string
}

export function createApplyPatchTool(opts: ApplyPatchOptions = {}) {
	const { cwd } = opts

	/**
	 * Resolve a file path to absolute if cwd is provided and path is relative.
	 */
	const resolvePath = (filePath: string): string => {
		if (!cwd || isAbsolute(filePath)) {
			return filePath
		}
		return resolve(cwd, filePath)
	}

	return ApplyPatchTool.define(
		async (input) => {
			const { patch_text } = input

			if (!patch_text || !patch_text.trim()) {
				throw new Error('patch_text is required')
			}

			let ops: PatchOperation[]
			try {
				ops = parsePatch(patch_text)
			} catch (err) {
				throw new Error(`apply_patch verification failed: ${err}`)
			}

			if (ops.length === 0) {
				throw new Error('patch rejected: empty patch')
			}

			const hasHunks = ops.some((op) => op.type === 'add' || op.chunks.length > 0 || op.type === 'delete')
			if (!hasHunks) {
				throw new Error('apply_patch verification failed: no hunks found')
			}

			// Read helper - resolves relative paths against cwd
			const readFile = async (filePath: string): Promise<string> => {
				const absolutePath = resolvePath(filePath)
				const file = Bun.file(absolutePath)
				if (!(await file.exists())) {
					throw new Error(`File not found: ${filePath}`)
				}
				return file.text()
			}

			// Validation phase — reads only, no writes
			await validateHunks(ops, readFile)

			// Apply phase — all writes after full validation (atomic-ish)
			const results: string[] = []

			for (const op of ops) {
				if (op.type === 'add') {
					const filePath = resolvePath(op.filePath)
					await mkdir(dirname(filePath), { recursive: true })
					// Ensure trailing newline like opencode
					const addContent = op.addContent ?? ''
					const content =
						addContent.length === 0 || addContent.endsWith('\n') ? addContent : `${addContent}\n`
					await Bun.write(filePath, content)
					results.push(`Added ${op.filePath}`)
				} else if (op.type === 'update') {
					const filePath = resolvePath(op.filePath)
					const content = await readFile(op.filePath)
					const updated = applyUpdateChunks(content, op.chunks)
					await Bun.write(filePath, updated)
					results.push(`Updated ${op.filePath}`)
				} else if (op.type === 'move') {
					const filePath = resolvePath(op.filePath)
					const content = await readFile(op.filePath)
					const updated = applyUpdateChunks(content, op.chunks)
					const targetPath = resolvePath(op.targetPath!)
					await mkdir(dirname(targetPath), { recursive: true })
					await Bun.write(targetPath, updated)
					await unlink(filePath)
					results.push(`Moved ${op.filePath} → ${op.targetPath}`)
				} else if (op.type === 'delete') {
					const filePath = resolvePath(op.filePath)
					await unlink(filePath)
					results.push(`Deleted ${op.filePath}`)
				}
			}

			return results.join('\n')
		},
		{ description: APPLY_PATCH_DESCRIPTION },
	)
}
