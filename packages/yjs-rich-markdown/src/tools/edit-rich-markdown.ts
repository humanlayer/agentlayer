import { EDIT_DESCRIPTION } from '@humanlayer/agentlayer-core'
import { EditTool } from '@humanlayer/agentlayer-core/interfaces'
import type * as Y from 'yjs'
import type { RichMarkdownArtifactStore } from '../artifact-store'
/**
 * Edit tool for editing markdown. Uses the EditTool interface but deletes to code-mode sub-agent for edits
 * @param artifactStore
 * @returns
 */
export function createEditRichMarkdownTool(artifactStore: RichMarkdownArtifactStore) {
	return EditTool.define(
		async (input, ctx) => {
			let matchCount: 0
			const artifact = artifactStore.getArtifact(input.file_path)

			const fragment: Y.XmlFragment = artifactStore.getFragment(input.file_path)

			return { content: '', matchCount: 0 }
		},
		{
			description: EDIT_DESCRIPTION,
		},
	)
}
