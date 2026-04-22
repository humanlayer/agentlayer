import * as Y from 'yjs'

export function syncDoc(source: Y.Doc, target: Y.Doc): void {
	Y.applyUpdate(target, Y.encodeStateAsUpdate(source))

	const sourceContentDocs = source.getMap<Y.Doc>('contentDocs')
	const targetContentDocs = target.getMap<Y.Doc>('contentDocs')

	for (const [guid, sourceSubdoc] of sourceContentDocs.entries()) {
		const targetSubdoc = targetContentDocs.get(guid)
		if (!targetSubdoc) {
			continue
		}

		Y.applyUpdate(targetSubdoc, Y.encodeStateAsUpdate(sourceSubdoc))
	}
}

export function syncBothWays(docA: Y.Doc, docB: Y.Doc): void {
	syncDoc(docA, docB)
	syncDoc(docB, docA)
}
