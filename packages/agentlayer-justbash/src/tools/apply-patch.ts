import { isAbsolute, resolve } from 'node:path'
import { ApplyPatchTool } from '@humanlayer/agentlayer-core/interfaces'
import { APPLY_PATCH_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import { applyUpdateChunks, type PatchOperation, parsePatch, validateHunks } from '@humanlayer/agentlayer-core/utils'
import type { Bash } from 'just-bash'

export interface ApplyPatchOptions {
	/** Working directory for resolving relative paths. If not provided, paths are resolved by bash's cwd. */
	cwd?: string
}

export function createApplyPatchTool(bash: Bash, opts: ApplyPatchOptions = {}) {
	const { cwd } = opts

	/**
	 * Resolve a file path to absolute if cwd is provided and path is relative.
	 * Note: bash.exec already uses bash's cwd, but this ensures consistency
	 * when passing paths to commands.
	 */
	const _resolvePath = (filePath: string): string => {
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

			// Read helper via bash
			const readFile = async (filePath: string): Promise<string> => {
				const result = await bash.exec(`cat "${filePath}"`)
				if (result.exitCode !== 0) {
					throw new Error(`File not found: ${filePath}`)
				}
				return result.stdout
			}

			// Validation phase — reads only, no writes
			await validateHunks(ops, readFile)

			// Apply phase
			const results: string[] = []

			for (const op of ops) {
				if (op.type === 'add') {
					const filePath = op.filePath
					// Ensure parent directory exists
					const mkdirResult = await bash.exec(`mkdir -p "$(dirname "${filePath}")"`)
					if (mkdirResult.exitCode !== 0) {
						throw new Error(`Failed to create parent directory for ${filePath}: ${mkdirResult.stderr}`)
					}
					// Write content using a heredoc
					const DELIM = 'PATCHEOF_8f3a2b1c'
					const content = op.addContent ?? ''
					const writeResult = await bash.exec(`cat > "${filePath}" <<'${DELIM}'\n${content}\n${DELIM}`)
					if (writeResult.exitCode !== 0) {
						throw new Error(`Failed to write file ${filePath}: ${writeResult.stderr}`)
					}
					results.push(`Added ${filePath}`)
				} else if (op.type === 'update') {
					const content = await readFile(op.filePath)
					const updated = applyUpdateChunks(content, op.chunks)
					const DELIM = 'PATCHEOF_8f3a2b1c'
					const writeResult = await bash.exec(`cat > "${op.filePath}" <<'${DELIM}'\n${updated}\n${DELIM}`)
					if (writeResult.exitCode !== 0) {
						throw new Error(`Failed to write file ${op.filePath}: ${writeResult.stderr}`)
					}
					results.push(`Updated ${op.filePath}`)
				} else if (op.type === 'move') {
					const content = await readFile(op.filePath)
					const updated = applyUpdateChunks(content, op.chunks)
					const targetPath = op.targetPath!
					const mkdirResult = await bash.exec(`mkdir -p "$(dirname "${targetPath}")"`)
					if (mkdirResult.exitCode !== 0) {
						throw new Error(`Failed to create parent directory for ${targetPath}: ${mkdirResult.stderr}`)
					}
					const DELIM = 'PATCHEOF_8f3a2b1c'
					const writeResult = await bash.exec(`cat > "${targetPath}" <<'${DELIM}'\n${updated}\n${DELIM}`)
					if (writeResult.exitCode !== 0) {
						throw new Error(`Failed to write file ${targetPath}: ${writeResult.stderr}`)
					}
					const rmResult = await bash.exec(`rm "${op.filePath}"`)
					if (rmResult.exitCode !== 0) {
						throw new Error(`Failed to remove original file ${op.filePath}: ${rmResult.stderr}`)
					}
					results.push(`Moved ${op.filePath} → ${targetPath}`)
				} else if (op.type === 'delete') {
					const rmResult = await bash.exec(`rm "${op.filePath}"`)
					if (rmResult.exitCode !== 0) {
						throw new Error(`Failed to delete file ${op.filePath}: ${rmResult.stderr}`)
					}
					results.push(`Deleted ${op.filePath}`)
				}
			}

			return results.join('\n')
		},
		{ description: APPLY_PATCH_DESCRIPTION },
	)
}
