import { z } from 'zod'
import { defineToolInterface } from '../../core/define-tool'

const CONTEXT7_BASE_URL = 'https://context7.com'
const DEFAULT_TIMEOUT_MS = 30_000

export const getContextInput = z.object({
	query: z.string().describe('The question or topic to get documentation context for'),
	libraryId: z.string().describe('The Context7 library ID (from context7_library_search results)'),
})

export type GetContextInput = z.infer<typeof getContextInput>

export const GetContextTool = defineToolInterface<GetContextInput, string>({
	name: 'context7_get_context',
	description:
		'Fetch documentation context for a specific library from Context7. Requires a library ID obtained from context7_library_search.',
	input: getContextInput,
	serialize: (result: string) => result,
})

export interface Context7GetContextOptions {
	apiKey: string
	tokens?: number
	timeoutMs?: number
}

export function createGetContextTool(opts: Context7GetContextOptions) {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

	return GetContextTool.define(async (input: GetContextInput): Promise<string> => {
		const params = new URLSearchParams({
			query: input.query,
			libraryId: input.libraryId,
			type: 'txt',
		})

		if (opts.tokens) {
			params.set('tokens', opts.tokens.toString())
		}

		const response = await fetch(`${CONTEXT7_BASE_URL}/api/v2/context?${params}`, {
			headers: { Authorization: `Bearer ${opts.apiKey}` },
			signal: AbortSignal.timeout(timeoutMs),
		})

		if (!response.ok) {
			const text = await response.text().catch(() => '')
			throw new Error(`Context7 context error ${response.status}: ${text}`)
		}

		return response.text()
	})
}
