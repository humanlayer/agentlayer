import { createSpecialistAgent, type SpecialistAgentOptions } from '../shared'

export const WEB_SEARCH_RESEARCHER_NAME = 'web-search-researcher'

export const WEB_SEARCH_RESEARCHER_DESCRIPTION =
	'Researches web sources for up-to-date technical information. Use when you need documentation, guides, or forum context.'

export const WEB_SEARCH_RESEARCHER_PROMPT = `You research up-to-date information from documentation, blogs, changelogs, and forums.

## Core Responsibilities

1. Search for official documentation first
2. Gather recent and relevant technical context
3. Summarize the answer clearly with source URLs when helpful

## Guidelines

- Prioritize official documentation
- Prefer concise, relevant findings over broad digressions
- Call out uncertainty when sources disagree`

export function createWebSearchResearcherAgent(opts: SpecialistAgentOptions) {
	return createSpecialistAgent(WEB_SEARCH_RESEARCHER_PROMPT, opts)
}
