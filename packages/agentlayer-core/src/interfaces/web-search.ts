import { z } from 'zod'
import { defineToolInterface } from '../define-tool'

export const webSearchInput = z.object({
	query: z.string().describe('Search query'),
	numResults: z.number().optional().default(5).describe('Max results to return'),
})

export type WebSearchInput = z.infer<typeof webSearchInput>

export const WebSearchResultItemSchema = z.object({
	title: z.string(),
	url: z.string(),
	snippet: z.string(),
})

export const WebSearchResultSchema = z.object({
	results: z.array(WebSearchResultItemSchema),
})

export type WebSearchResultItem = z.infer<typeof WebSearchResultItemSchema>
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>

export const WebSearchTool = defineToolInterface<WebSearchInput, WebSearchResult>({
	name: 'websearch',
	description: 'Search the web for information',
	input: webSearchInput,
	output: WebSearchResultSchema,
	serialize: (result: WebSearchResult) => {
		if (result.results.length === 0) return 'No results found.'
		return result.results.map((r) => `${r.title}\n  ${r.url}\n  ${r.snippet}`).join('\n\n')
	},
})
