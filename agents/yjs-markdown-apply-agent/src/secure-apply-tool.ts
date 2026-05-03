import { defineTool } from '@humanlayer/agentlayer-core'
import { z } from 'zod'

export const secureApplyResultSchema = z.object({
	ok: z.boolean(),
	proposedUpdateBase64: z.string().optional(),
	beforeMarkdown: z.string().optional(),
	afterMarkdown: z.string().optional(),
	beforeXml: z.string().optional(),
	afterXml: z.string().optional(),
	changedArtifacts: z.array(z.string()).optional(),
	validationErrors: z.array(z.string()).optional(),
	operationLog: z.array(z.string()).optional(),
})

export const secureApplyToolInputSchema = z.object({
	generatedCode: z.string().min(1),
})

export type SecureApplyToolInput = z.infer<typeof secureApplyToolInputSchema>
export type SecureApplyToolResult = z.infer<typeof secureApplyResultSchema>

export type SecureApplyExecutor = (input: SecureApplyToolInput, signal: AbortSignal) => Promise<SecureApplyToolResult>

export function createSecureApplyTool(executor: SecureApplyExecutor) {
	return defineTool({
		name: 'secure_apply_yjs_update',
		description:
			'Run generated JavaScript in a secure disconnected Yjs apply environment. The code must return a SecureApplyResult with a proposed Yjs update.',
		input: secureApplyToolInputSchema,
		output: secureApplyResultSchema,
		async execute(input, ctx) {
			return executor(input, ctx.signal)
		},
	})
}

export function createFakeSecureApplyExecutor(result: SecureApplyToolResult): SecureApplyExecutor {
	return async () => result
	}
