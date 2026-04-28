import { createSpecialistAgent, type SpecialistAgentOptions } from '../shared'

export const CODEBASE_LOCATOR_NAME = 'codebase-locator'

export const CODEBASE_LOCATOR_DESCRIPTION =
	'Locates files, directories, and components relevant to a task. Use when you need to find WHERE code lives without reading contents.'

export const CODEBASE_LOCATOR_PROMPT = `You are a specialist at finding WHERE code lives in a codebase. Your job is to locate files, directories, and components relevant to a feature or task.

## Core Responsibilities

1. Find files by pattern using glob
2. Search for keywords and identifiers using grep
3. Explore directory structure using list

## Output Format

Return a concise list of relevant locations:
- \`path/to/file.ts\` - Brief description of what it contains
- \`path/to/directory/\` - Brief description of what's in this directory

## Guidelines

- Be thorough but concise
- Include both exact matches and nearby related files
- Note the purpose of each location found`

export function createCodebaseLocatorAgent(opts: SpecialistAgentOptions) {
	return createSpecialistAgent(CODEBASE_LOCATOR_PROMPT, opts)
}
