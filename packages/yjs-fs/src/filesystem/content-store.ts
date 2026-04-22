import * as Y from 'yjs'
import { type ContentId, type EditResult, EntryNotFoundError } from '../types'

const CONTENT_DOCS_KEY = 'contentDocs'
const CONTENT_TEXT_KEY = 'content'

export class ContentStore {
	readonly doc: Y.Doc
	private readonly contentDocs: Y.Map<Y.Doc>

	constructor(doc: Y.Doc) {
		this.doc = doc
		this.contentDocs = doc.getMap<Y.Doc>(CONTENT_DOCS_KEY)
	}

	create(content = ''): { contentId: ContentId; doc: Y.Doc; text: Y.Text } {
		const contentDoc = new Y.Doc({ guid: crypto.randomUUID() })
		const text = contentDoc.getText(CONTENT_TEXT_KEY)

		if (content.length > 0) {
			text.insert(0, content)
		}

		this.contentDocs.set(contentDoc.guid, contentDoc)
		return {
			contentId: contentDoc.guid,
			doc: contentDoc,
			text,
		}
	}

	delete(contentId: ContentId): void {
		this.contentDocs.delete(contentId)
	}

	get(contentId: ContentId, pathForErrors: string): Y.Doc {
		const contentDoc = this.contentDocs.get(contentId)
		if (!contentDoc) {
			throw new EntryNotFoundError(pathForErrors)
		}

		return contentDoc
	}

	getText(contentId: ContentId, pathForErrors: string): Y.Text {
		return this.get(contentId, pathForErrors).getText(CONTENT_TEXT_KEY)
	}

	read(contentId: ContentId, pathForErrors: string): string {
		return this.getText(contentId, pathForErrors).toString()
	}

	write(contentId: ContentId, pathForErrors: string, content: string): number {
		const text = this.getText(contentId, pathForErrors)
		this.doc.transact(() => {
			text.delete(0, text.length)
			if (content.length > 0) {
				text.insert(0, content)
			}
		})

		return content.length
	}

	edit(contentId: ContentId, pathForErrors: string, oldText: string, newText: string): EditResult {
		const text = this.getText(contentId, pathForErrors)
		const content = text.toString()
		const firstIndex = content.indexOf(oldText)

		if (firstIndex === -1) {
			throw new Error(`No match found for oldText in ${pathForErrors}`)
		}

		if (content.indexOf(oldText, firstIndex + 1) !== -1) {
			throw new Error(
				'Found multiple matches for oldText. Provide more surrounding context to make the match unique.',
			)
		}

		const editLine = content.slice(0, firstIndex).split('\n').length
		const affectedLines = {
			start: editLine,
			end: editLine + newText.split('\n').length - 1,
		}

		this.doc.transact(() => {
			text.delete(firstIndex, oldText.length)
			text.insert(firstIndex, newText)
		})

		return {
			path: pathForErrors,
			editIndex: firstIndex,
			editLine,
			affectedLines,
		}
	}

	size(contentId: ContentId, pathForErrors: string): number {
		return this.getText(contentId, pathForErrors).toString().length
	}
}
