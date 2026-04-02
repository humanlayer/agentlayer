import { z } from 'zod'
import { defineToolInterface } from '../../core/define-tool'
import type { Context7SearchResponse } from './types'

const CONTEXT7_BASE_URL = 'https://context7.com'
const DEFAULT_TIMEOUT_MS = 15_000

export const librarySearchInput = z.object({
	query: z.string().describe('Search query for finding library documentation'),
	libraryName: z.string().describe('Name of the library to search for'),
})

export type LibrarySearchInput = z.infer<typeof librarySearchInput>

export const LibrarySearchResultSchema = z.object({
	libraries: z.array(
		z.object({
			id: z.string(),
			title: z.string(),
			description: z.string().optional(),
			trustScore: z.number().optional(),
		}),
	),
})

export type LibrarySearchResult = z.infer<typeof LibrarySearchResultSchema>

export const LibrarySearchTool = defineToolInterface<LibrarySearchInput, LibrarySearchResult>({
	name: 'context7_library_search',
	description:
		'Search for library documentation via Context7. Returns a list of matching libraries with IDs that can be used with context7_get_context.',
	input: librarySearchInput,
	output: LibrarySearchResultSchema,
	serialize: (result: LibrarySearchResult) => {
		if (result.libraries.length === 0) return 'No libraries found.'
		return result.libraries
			.map((lib) => `- ${lib.title} (id: ${lib.id})${lib.description ? `\n  ${lib.description}` : ''}`)
			.join('\n')
	},
})

export interface Context7LibrarySearchOptions {
	apiKey: string
	topN?: number
	timeoutMs?: number
}

export function createLibrarySearchTool(opts: Context7LibrarySearchOptions) {
	const topN = opts.topN ?? 5
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

	return LibrarySearchTool.define(async (input: LibrarySearchInput): Promise<LibrarySearchResult> => {
		const params = new URLSearchParams({ query: input.query, libraryName: input.libraryName })
		const response = await fetch(`${CONTEXT7_BASE_URL}/api/v2/libs/search?${params}`, {
			headers: { Authorization: `Bearer ${opts.apiKey}` },
			signal: AbortSignal.timeout(timeoutMs),
		})

		if (!response.ok) {
			const text = await response.text().catch(() => '')
			throw new Error(`Context7 search error ${response.status}: ${text}`)
		}

		const data = (await response.json()) as Context7SearchResponse
		const libraries = (data.results ?? []).slice(0, topN).map((lib) => ({
			id: lib.id,
			title: lib.title,
			description: lib.description,
			trustScore: lib.trustScore,
		}))

		return { libraries }
	})
}
