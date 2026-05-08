import { anthropic } from '@ai-sdk/anthropic'
import { Agent, defineTool, doomLoop, maxSteps, startState, userMessage } from '@humanlayer/agentlayer-core'
import dedent from 'dedent'
import z from 'zod/v4'
import type { RichMarkdownArtifactStore } from '../artifact-store'
import { readArtifactMarkdown, writeArtifactMarkdown } from '../markdown'
import { createEditRichMarkdownTool } from '../tools'

export type CreateRichMarkdownCliAgentOptions = {
	model: ConstructorParameters<typeof Agent>[0]['model']
	artifactStore: RichMarkdownArtifactStore
}

export const anthropicEphemeralProviderOptions = {
	anthropic: {
		cacheControl: { type: 'ephemeral' },
	},
} as const

export function createRichMarkdownCliAgent(options: CreateRichMarkdownCliAgentOptions) {
	const { model, artifactStore } = options

	const listArtifactsTool = defineTool({
		name: 'list_artifacts',
		description: 'List rich markdown artifact paths available in the connected Yjs document.',
		input: z.object({}),
		execute: async () => {
			const artifacts = artifactStore.listArtifacts()
			if (artifacts.length === 0) return 'No rich markdown artifacts found.'
			return artifacts.map((artifact) => artifact.path).join('\n')
		},
	})

	const readArtifactTool = defineTool({
		name: 'read_artifact',
		description: 'Read one rich markdown artifact as Markdown.',
		input: z.object({
			path: z.string().describe('Artifact path to read, e.g. /artifacts/README.md'),
		}),
		execute: async ({ path }) => {
			artifactStore.getArtifact(path)
			return readArtifactMarkdown(artifactStore.doc, path)
		},
	})

	const writeArtifactTool = defineTool({
		name: 'write_artifact',
		description: 'Replace one rich markdown artifact with Markdown content.',
		input: z.object({
			path: z.string().describe('Artifact path to write, e.g. /artifacts/README.md'),
			markdown: z.string().describe('Full Markdown content for the artifact'),
		}),
		execute: async ({ path, markdown }) => {
			artifactStore.ensureArtifact(path)
			writeArtifactMarkdown(artifactStore.doc, path, markdown)
			return `Wrote ${path}`
		},
	})

	const inspectArtifactTool = defineTool({
		name: 'inspect_artifact',
		description: 'Inspect one rich markdown artifact as its internal YXml serialization.',
		input: z.object({
			path: z.string().describe('Artifact path to inspect, e.g. /artifacts/README.md'),
		}),
		execute: async ({ path }) => {
			artifactStore.getArtifact(path)
			return artifactStore.getFragment(path).toJSON()
		},
	})

	return new Agent({
		system: cliAgentPrompt,
		model,
		tools: {
			list_artifacts: listArtifactsTool,
			read_artifact: readArtifactTool,
			write_artifact: writeArtifactTool,
			inspect_artifact: inspectArtifactTool,
			edit: createEditRichMarkdownTool(artifactStore, {
				model,
				providerOptions: anthropicEphemeralProviderOptions as ConstructorParameters<
					typeof Agent
				>[0]['providerOptions'],
			}),
		},
		providerOptions: anthropicEphemeralProviderOptions as ConstructorParameters<typeof Agent>[0]['providerOptions'],
		stopWhen: [doomLoop(), maxSteps(50)],
	})
}

export function defaultRichMarkdownCliModel() {
	return anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6')
}

export function createRichMarkdownCliAgentState(prompt: string) {
	return startState([userMessage(prompt)])
}

const cliAgentPrompt = dedent`
	You are a CLI agent connected to a live Durable Streams-backed Yjs document containing rich markdown artifacts.

	Use Markdown as the user-facing format:
	- Use list_artifacts to discover available artifact paths.
	- Use read_artifact to inspect current Markdown.
	- Use write_artifact only when replacing an entire artifact is intended.
	- Use edit for targeted old_string/new_string edits. The edit tool delegates to a rich markdown apply sub-agent that mutates the live Y.XmlFragment structurally through QuickJS proxy bindings.
	- Use inspect_artifact only for debugging internal YXml structure.

	After completing the requested work, respond with a concise summary of changed artifact paths.
`
