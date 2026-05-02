import type * as Y from 'yjs'
import { artifactFragment } from './tiptap-bindings'

export function readArtifact(doc: Y.Doc, path: string): string {
	return artifactFragment(doc, path).toString()
}
