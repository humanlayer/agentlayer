import type { Extension } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import StarterKit from '@tiptap/starter-kit'
import type * as Y from 'yjs'
import { type ArtifactPath, artifactFragmentName, normalizeArtifactPath } from './artifact-path'

export type ArtifactCollaborationMode = 'fragment' | 'field'

export type ArtifactCollaborationOptions = {
	doc: Y.Doc
	path: ArtifactPath
	mode?: ArtifactCollaborationMode
}

export function artifactFragment(doc: Y.Doc, path: string): Y.XmlFragment {
	return doc.getXmlFragment(artifactFragmentName(normalizeArtifactPath(path)))
}

export function artifactCollaborationExtension(options: ArtifactCollaborationOptions): Extension {
	const path = normalizeArtifactPath(options.path)
	if (options.mode === 'field') {
		return Collaboration.configure({
			document: options.doc,
			field: artifactFragmentName(path),
		})
	}

	return Collaboration.configure({
		fragment: artifactFragment(options.doc, path),
	})
}

export function defaultRichMarkdownExtensions(options: ArtifactCollaborationOptions): Extension[] {
	return [
		StarterKit.configure({
			undoRedo: false,
		}),
		artifactCollaborationExtension(options),
	]
}
