import * as Y from 'yjs'
import { type ContentId, type EditResult, EntryNotFoundError } from './types'

const FILES_KEY = 'files'
const CONTENT_TEXT_KEY = 'content'
const CONTENT_BINARY_KEY = 'binary'

type FileRecord = Y.Map<unknown>
type BinaryRecord = Y.Map<unknown>

/**
 * Store for file content records kept under the root Y.Doc's `files` map.
 *
 * The catalog owns namespace metadata and stable entry ids; this store owns the
 * collaborative Yjs payload addressed by stable `contentId`s.
 */
export class ContentStore {
	readonly doc: Y.Doc
	private readonly files: Y.Map<FileRecord>

	/** Binds the content store to the shared `files` map in the root document. */
	constructor(doc: Y.Doc) {
		this.doc = doc
		this.files = doc.getMap<FileRecord>(FILES_KEY)
	}

	/** Creates a text file record containing a `Y.Text` instance. */
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

	/** Creates a binary file record containing a `Y.Array<number>`. */
	createBinary(content: Uint8Array = new Uint8Array(0)): {
		contentId: ContentId
		record: BinaryRecord
		data: Y.Array<number>
	} {
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

	/** Deletes a content record by stable content id. */
	delete(contentId: ContentId): void {
		this.files.delete(contentId)
	}

	/** Returns the raw shared record for a file's content state. */
	get(contentId: ContentId, pathForErrors: string): FileRecord {
		const record = this.files.get(contentId)
		if (!(record instanceof Y.Map)) {
			throw new EntryNotFoundError(pathForErrors)
		}

		return record
	}

	/**
	 * Subscribes to any deep changes within one file record.
	 *
	 * Because comments live inside the same record as content, this listener sees
	 * both text/binary edits and comment mutations.
	 */
	subscribe(contentId: ContentId, pathForErrors: string, listener: () => void): () => void {
		const record = this.get(contentId, pathForErrors)
		let queued = false
		const notify = () => {
			if (queued) {
				return
			}

			queued = true
			queueMicrotask(() => {
				queued = false
				listener()
			})
		}

		record.observeDeep(notify)
		return () => {
			record.unobserveDeep(notify)
		}
	}

	/** Returns the `Y.Text` payload for a text file record. */
	getText(contentId: ContentId, pathForErrors: string): Y.Text {
		const text = this.get(contentId, pathForErrors).get(CONTENT_TEXT_KEY)
		if (!(text instanceof Y.Text)) {
			throw new EntryNotFoundError(pathForErrors)
		}

		return text
	}

	/** Returns the `Y.Array<number>` payload for a binary file record. */
	getBinaryData(contentId: ContentId, pathForErrors: string): Y.Array<number> {
		const data = this.get(contentId, pathForErrors).get(CONTENT_BINARY_KEY)
		if (!(data instanceof Y.Array)) {
			throw new EntryNotFoundError(pathForErrors)
		}

		return data as Y.Array<number>
	}

	/** Reads the current string contents of a text file. */
	read(contentId: ContentId, pathForErrors: string): string {
		return this.getText(contentId, pathForErrors).toString()
	}

	/** Reads the current bytes of a binary file. */
	readBinary(contentId: ContentId, pathForErrors: string): Uint8Array {
		const data = this.getBinaryData(contentId, pathForErrors)
		return new Uint8Array(data.toArray())
	}

	/** Replaces the entire contents of a text file. */
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

	/** Replaces the entire contents of a binary file. */
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

	/**
	 * Replaces one uniquely matched substring in a text file.
	 *
	 * This powers higher-level edit operations that want a precise replacement but
	 * still rely on the collaborative `Y.Text` as the source of truth.
	 */
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

	/** Returns the current character length of a text file. */
	size(contentId: ContentId, pathForErrors: string): number {
		return this.getText(contentId, pathForErrors).toString().length
	}

	/** Returns the current byte count of a binary file. */
	sizeBinary(contentId: ContentId, pathForErrors: string): number {
		return this.getBinaryData(contentId, pathForErrors).length
	}
}
