import type { JSONContent } from '@tiptap/core'
import { getSchema } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from 'y-prosemirror'
import type * as Y from 'yjs'
import { artifactFragment } from './tiptap-bindings'

const markdownExtensions = [StarterKit]

export function markdownToTiptapJson(markdown: string): JSONContent {
	return createMarkdownManager().parse(markdown)
}

export function tiptapJsonToMarkdown(json: JSONContent): string {
	return createMarkdownManager().serialize(json)
}

export function writeArtifactMarkdown(doc: Y.Doc, path: string, markdown: string): void {
	const fragment = artifactFragment(doc, path)
	const json = markdownToTiptapJson(markdown)
	replaceFragmentWithTiptapJson(fragment, json)
}

export function readArtifactMarkdown(doc: Y.Doc, path: string): string {
	const fragment = artifactFragment(doc, path)
	return tiptapJsonToMarkdown(yXmlFragmentToProsemirrorJSON(fragment) as JSONContent)
}

function createMarkdownManager(): MarkdownManager {
	return new MarkdownManager({ extensions: markdownExtensions })
}

function replaceFragmentWithTiptapJson(fragment: Y.XmlFragment, json: JSONContent): void {
	fragment.delete(0, fragment.length)
	prosemirrorJSONToYXmlFragment(getSchema(markdownExtensions), json, fragment)
}
