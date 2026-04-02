import { z } from 'zod'
import { defineToolInterface } from '../../core/define-tool'

export const webFetchInput = z.object({
	url: z.string().url().describe('URL to fetch (must start with http:// or https://)'),
	format: z
		.enum(['text', 'markdown', 'html'])
		.optional()
		.default('markdown')
		.describe('Output format: markdown (default, converts HTML), text (strips tags), html (raw)'),
	timeout: z.number().optional().default(30_000).describe('Request timeout in milliseconds (max 120000)'),
})

export type WebFetchInput = z.infer<typeof webFetchInput>

export const WebFetchTool = defineToolInterface<WebFetchInput>({
	name: 'webfetch',
	description: 'Fetch content from a URL, with optional HTML-to-markdown conversion',
	input: webFetchInput,
})
