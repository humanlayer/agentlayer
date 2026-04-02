import { z } from 'zod'
import { defineToolInterface } from '../../core/define-tool'

export const applyPatchInput = z.object({
	patchText: z.string().describe("Patch in '*** Begin Patch' / '*** End Patch' format"),
})

export type ApplyPatchInput = z.infer<typeof applyPatchInput>

/**
 * Unified edit tool for Codex/GPT-4 models.
 * Use INSTEAD OF EditTool + WriteTool when targeting these models.
 * These models are trained to produce unified diffs rather than string replacements.
 */
export const ApplyPatchTool = defineToolInterface({
	name: 'apply_patch',
	description: 'Apply a unified diff patch to one or more files',
	input: applyPatchInput,
})
