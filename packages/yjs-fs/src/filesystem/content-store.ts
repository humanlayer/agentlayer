import * as Y from 'yjs'
import { type ContentId, type EditResult, EntryNotFoundError } from './types'

const FILES_KEY = 'files'
const CONTENT_TEXT_KEY = 'content'
const CONTENT_BINARY_KEY = 'binary'

type FileRecord = Y.Map<unknown>
type BinaryRecord = Y.Map<unknown>

export class ContentStore {
	readonly doc: Y.Doc
	private readonly files: Y.Map<FileRecord>

	constructor(doc: Y.Doc) {
		this.doc = doc
		this.files = doc.getMap<FileRecord>(FILES_KEY)
	}

	create(content = ''): { contentId: ContentId; record: FileRecord; text: Y.Text } {
		const contentId = crypto.randomUUID()
		const record = new Y.Map<unknown>()
		const text = new Y.Text()
		record.set(CONTENT_TEXT_KEY, text)

		if (content.length > 0) {
			text.insert(0, content)
		}

		this.files.set(contentId, record)
		return {
			contentId,
			record,
			text,
		}
	}

	createBinary(content: Uint8Array = new Uint8Array(0)): { contentId: ContentId; record: BinaryRecord; data: Y.Array<number> } {
		const contentId = crypto.randomUUID()
		const record = new Y.Map<unknown>()
		const data = new Y.Array<number>()
		record.set(CONTENT_BINARY_KEY, data)

		if (content.length > 0) {
			data.insert(0, Array.from(content))
		}

		this.files.set(contentId, record)
		return {
			contentId,
			record,
			data,
		}
	}

	delete(contentId: ContentId): void {
		this.files.delete(contentId)
	}

	get(contentId: ContentId, pathForErrors: string): FileRecord {
		const record = this.files.get(contentId)
		if (!(record instanceof Y.Map)) {
			throw new EntryNotFoundError(pathForErrors)
		}

		return record
	}

	getText(contentId: ContentId, pathForErrors: string): Y.Text {
		const text = this.get(contentId, pathForErrors).get(CONTENT_TEXT_KEY)
		if (!(text instanceof Y.Text)) {
			throw new EntryNotFoundError(pathForErrors)
		}

		return text
	}

	getBinaryData(contentId: ContentId, pathForErrors: string): Y.Array<number> {
		const data = this.get(contentId, pathForErrors).get(CONTENT_BINARY_KEY)
		if (!(data instanceof Y.Array)) {
			throw new EntryNotFoundError(pathForErrors)
		}

		return data as Y.Array<number>
	}

	read(contentId: ContentId, pathForErrors: string): string {
		return this.getText(contentId, pathForErrors).toString()
	}

	readBinary(contentId: ContentId, pathForErrors: string): Uint8Array {
		const data = this.getBinaryData(contentId, pathForErrors)
		return new Uint8Array(data.toArray())
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

	writeBinary(contentId: ContentId, pathForErrors: string, content: Uint8Array): number {
		const data = this.getBinaryData(contentId, pathForErrors)
		this.doc.transact(() => {
			data.delete(0, data.length)
			if (content.length > 0) {
				data.insert(0, Array.from(content))
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

	sizeBinary(contentId: ContentId, pathForErrors: string): number {
		return this.getBinaryData(contentId, pathForErrors).length
	}
}
