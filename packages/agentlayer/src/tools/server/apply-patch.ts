import { mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { applyUpdateChunks, type PatchOperation, parsePatch, validateHunks } from '../../util/patch-parser'
import { ApplyPatchTool } from '../interfaces/apply-patch'
import DESCRIPTION from './apply-patch.txt'

export function createApplyPatchTool() {
	return ApplyPatchTool.define(
		async (input) => {
			const { patchText } = input

			if (!patchText || !patchText.trim()) {
				throw new Error('patchText is required')
			}

			let ops: PatchOperation[]
			try {
				ops = parsePatch(patchText)
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

			// Read helper
			const readFile = async (filePath: string): Promise<string> => {
				const file = Bun.file(filePath)
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
					const filePath = op.filePath
					await mkdir(dirname(filePath), { recursive: true })
					// Ensure trailing newline like opencode
					const addContent = op.addContent ?? ''
					const content =
						addContent.length === 0 || addContent.endsWith('\n') ? addContent : `${addContent}\n`
					await Bun.write(filePath, content)
					results.push(`Added ${filePath}`)
				} else if (op.type === 'update') {
					const content = await readFile(op.filePath)
					const updated = applyUpdateChunks(content, op.chunks)
					await Bun.write(op.filePath, updated)
					results.push(`Updated ${op.filePath}`)
				} else if (op.type === 'move') {
					const content = await readFile(op.filePath)
					const updated = applyUpdateChunks(content, op.chunks)
					const targetPath = op.targetPath!
					await mkdir(dirname(targetPath), { recursive: true })
					await Bun.write(targetPath, updated)
					await unlink(op.filePath)
					results.push(`Moved ${op.filePath} → ${targetPath}`)
				} else if (op.type === 'delete') {
					await unlink(op.filePath)
					results.push(`Deleted ${op.filePath}`)
				}
			}

			return results.join('\n')
		},
		{ description: DESCRIPTION },
	)
}
