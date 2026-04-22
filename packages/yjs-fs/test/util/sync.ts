import * as Y from 'yjs'

export function syncDoc(source: Y.Doc, target: Y.Doc): void {
	Y.applyUpdate(target, Y.encodeStateAsUpdate(source))
}

export function syncBothWays(docA: Y.Doc, docB: Y.Doc): void {
	syncDoc(docA, docB)
	syncDoc(docB, docA)
}
