import { EDIT_DESCRIPTION, startState, userMessage } from '@humanlayer/agentlayer-core'
import { EditTool } from '@humanlayer/agentlayer-core/interfaces'
import type * as Y from 'yjs'
import type { RichMarkdownArtifactStore } from '../artifact-store'
import { readArtifactMarkdown } from '../markdown'
import { createYXmlFragmentEditorAgent, userInstructionForYXmlFragmentEditorAgent } from '../agents'

export type CreateEditRichMarkdownToolOptions = {
	model: Parameters<typeof createYXmlFragmentEditorAgent>[0]['modelConfig']
	providerOptions?: Parameters<typeof createYXmlFragmentEditorAgent>[0]['providerOptions']
}

/**
 * Edit tool for editing markdown. Uses the EditTool interface but deletes to code-mode sub-agent for edits
 * @param artifactStore
 * @returns
 */
export function createEditRichMarkdownTool(
	artifactStore: RichMarkdownArtifactStore,
	options: CreateEditRichMarkdownToolOptions,
) {
	return EditTool.define(
		async (input, ctx) => {
			artifactStore.getArtifact(input.file_path)
			const fragment: Y.XmlFragment = artifactStore.getFragment(input.file_path)
			const beforeMarkdown = readArtifactMarkdown(artifactStore.doc, input.file_path)

			const applyAgent = createYXmlFragmentEditorAgent({
				modelConfig: options.model,
				fragment,
				providerOptions: options.providerOptions,
			})

			const run = applyAgent.run({
				state: startState([
					userMessage(
						userInstructionForYXmlFragmentEditorAgent({
							oldString: input.old_string,
							newString: input.new_string,
							replaceAll: input.replace_all,
						}),
					),
				]),
				stream: ctx.stream,
				signal: ctx.signal,
			})

			if (ctx.awaitSubAgent && ctx.toolCallId) {
				await ctx.awaitSubAgent(run, `rich-markdown-apply:${input.file_path}`, ctx.toolCallId)
			} else {
				await run.result
			}

			const afterMarkdown = readArtifactMarkdown(artifactStore.doc, input.file_path)
			const changed = beforeMarkdown !== afterMarkdown

			return { content: afterMarkdown, matchCount: changed ? 1 : 0 }
		},
		{
			description: EDIT_DESCRIPTION,
		},
	)
}
