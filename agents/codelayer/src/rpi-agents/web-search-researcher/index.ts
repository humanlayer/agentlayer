import { createSpecialistAgent, type SpecialistAgentOptions } from '../shared'

export const WEB_SEARCH_RESEARCHER_NAME = 'web-search-researcher'

export const WEB_SEARCH_RESEARCHER_DESCRIPTION =
	'Researches web sources for up-to-date technical information. Use when you need documentation, guides, or forum context.'

export const WEB_SEARCH_RESEARCHER_PROMPT =
	'do not use control-chrome or control-browser or browser related skills unless the user explicitly requests them, stick to the web search/fetch tools'

export function createWebSearchResearcherAgent(opts: SpecialistAgentOptions) {
	return createSpecialistAgent(WEB_SEARCH_RESEARCHER_PROMPT, opts)
}
