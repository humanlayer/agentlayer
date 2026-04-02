/**
 * Patch parser for the *** Begin Patch / *** End Patch format.
 *
 * Modeled on opencode's src/patch/index.ts. Supports Add / Update / Delete / Move
 * file operations. The heavy fuzzy-matching from opencode is included so that
 * minor whitespace differences in context lines still match.
 */

export type PatchOperationType = 'add' | 'update' | 'delete' | 'move'

export interface PatchChunk {
	/** Lines that must be found in the original file (context + remove) */
	oldLines: string[]
	/** Lines that replace the old lines (context + add) */
	newLines: string[]
	/** Optional context text from @@ header for disambiguation */
	changeContext?: string
	/** If true, this chunk extends to the end of the file */
	endOfFile: boolean
}

export interface PatchOperation {
	type: PatchOperationType
	filePath: string
	/** Destination path for 'move' operations */
	targetPath?: string
	/** Raw new-file content for 'add' operations */
	addContent?: string
	/** Ordered hunks for 'update' operations */
	chunks: PatchChunk[]
}

// ─── Normalisation helpers (unicode fuzzy matching) ──────────────────────────

function normalizeUnicode(s: string): string {
	return s
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'") // curly single quotes → apostrophe
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"') // curly double quotes → straight
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-') // dashes → hyphen
		.replace(/\u2026/g, '...') // ellipsis → three dots
		.replace(/\u00A0/g, ' ') // non-breaking space → regular space
}

type Comparator = (a: string, b: string) => boolean

function tryMatch(lines: string[], pattern: string[], startIndex: number, compare: Comparator, eof: boolean): number {
	// If EOF anchor, try matching from end of file first
	if (eof) {
		const fromEnd = lines.length - pattern.length
		if (fromEnd >= startIndex) {
			let matches = true
			for (let j = 0; j < pattern.length; j++) {
				if (!compare(lines[fromEnd + j]!, pattern[j]!)) {
					matches = false
					break
				}
			}
			if (matches) return fromEnd
		}
	}

	// Forward search from startIndex
	for (let i = startIndex; i <= lines.length - pattern.length; i++) {
		let matches = true
		for (let j = 0; j < pattern.length; j++) {
			if (!compare(lines[i + j]!, pattern[j]!)) {
				matches = false
				break
			}
		}
		if (matches) return i
	}

	return -1
}

/**
 * 4-pass fuzzy seek: find the starting index of `needle` lines in `haystack`.
 * Returns -1 if not found. Supports startIndex and EOF anchoring.
 */
function seekSequence(haystack: string[], needle: string[], startIndex = 0, eof = false): number {
	if (needle.length === 0) return -1

	// Pass 1: exact match
	const exact = tryMatch(haystack, needle, startIndex, (a, b) => a === b, eof)
	if (exact !== -1) return exact

	// Pass 2: rstrip (trim trailing whitespace)
	const rstrip = tryMatch(haystack, needle, startIndex, (a, b) => a.trimEnd() === b.trimEnd(), eof)
	if (rstrip !== -1) return rstrip

	// Pass 3: trim (both ends)
	const trim = tryMatch(haystack, needle, startIndex, (a, b) => a.trim() === b.trim(), eof)
	if (trim !== -1) return trim

	// Pass 4: normalized (Unicode punctuation to ASCII)
	const normalized = tryMatch(
		haystack,
		needle,
		startIndex,
		(a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()),
		eof,
	)
	return normalized
}

// ─── Heredoc stripping ────────────────────────────────────────────────────────

/**
 * Strip a heredoc wrapper if present, returning the inner text.
 * Supports both `cat <<'EOF'...EOF` and bare `<<EOF...EOF`.
 */
export function stripHeredoc(patchText: string): string {
	const heredocRe = /^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/
	const m = patchText.trim().match(heredocRe)
	return m ? (m[2] ?? patchText) : patchText
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a patch string into structured PatchOperations.
 *
 * Throws with a descriptive message if the format is invalid.
 */
export function parsePatch(rawPatchText: string): PatchOperation[] {
	const patchText = stripHeredoc(rawPatchText)

	const lines = patchText.split('\n')

	// Find Begin/End markers
	const beginIdx = lines.findIndex((l) => l.trim() === '*** Begin Patch')
	const endIdx = lines.findIndex((l) => l.trim() === '*** End Patch')

	if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
		throw new Error("Invalid patch format: patch must begin with '*** Begin Patch' and end with '*** End Patch'")
	}

	const body = lines.slice(beginIdx + 1, endIdx)

	const operations: PatchOperation[] = []
	let i = 0

	while (i < body.length) {
		const line = body[i]!

		if (line.startsWith('*** Add File: ')) {
			const filePath = line.slice('*** Add File: '.length).trim()
			i++
			// Collect content lines, stripping leading '+' prefix like opencode
			let content = ''
			while (i < body.length && !body[i]!.startsWith('*** ')) {
				const cl = body[i]!
				if (cl.startsWith('+')) {
					content += `${cl.substring(1)}\n`
				}
				i++
			}
			// Remove trailing newline
			if (content.endsWith('\n')) {
				content = content.slice(0, -1)
			}
			operations.push({
				type: 'add',
				filePath,
				chunks: [],
				addContent: content,
			})
		} else if (line.startsWith('*** Delete File: ')) {
			const filePath = line.slice('*** Delete File: '.length).trim()
			i++
			// Skip any content lines (there shouldn't be any, but be safe)
			while (i < body.length && !body[i]!.startsWith('*** ')) {
				i++
			}
			operations.push({ type: 'delete', filePath, chunks: [] })
		} else if (line.startsWith('*** Update File: ')) {
			const filePath = line.slice('*** Update File: '.length).trim()
			i++

			// Optional "*** Move to:" line
			let targetPath: string | undefined
			if (i < body.length && body[i]!.startsWith('*** Move to: ')) {
				targetPath = body[i]!.slice('*** Move to: '.length).trim()
				i++
			}

			// Parse @@ chunks using old_lines/new_lines model
			const chunks: PatchChunk[] = []
			while (
				i < body.length &&
				(body[i]!.startsWith('@@') || body[i] === '*** End of File' || !body[i]!.startsWith('*** '))
			) {
				if (body[i]!.startsWith('@@')) {
					// Capture the @@ context text for disambiguation
					const contextLine = body[i]!.substring(2).trim()
					i++ // skip the @@ line itself

					const oldLines: string[] = []
					const newLines: string[] = []
					let isEndOfFile = false

					while (
						i < body.length &&
						!body[i]!.startsWith('@@') &&
						(body[i] === '*** End of File' || !body[i]!.startsWith('*** '))
					) {
						const cl = body[i]!
						if (cl === '*** End of File') {
							isEndOfFile = true
							i++
							break
						}
						const prefix = cl[0]
						const content = cl.slice(1) // strip leading ' ', '+', or '-'
						if (prefix === ' ') {
							// Context line — appears in both old and new
							oldLines.push(content)
							newLines.push(content)
						} else if (prefix === '-') {
							// Remove line — only in old
							oldLines.push(content)
						} else if (prefix === '+') {
							// Add line — only in new
							newLines.push(content)
						}
						i++
					}

					chunks.push({
						oldLines,
						newLines,
						changeContext: contextLine || undefined,
						endOfFile: isEndOfFile,
					})
				} else {
					// Unexpected line inside update block — skip
					i++
				}
			}

			const op: PatchOperation = {
				type: targetPath ? 'move' : 'update',
				filePath,
				chunks,
			}
			if (targetPath) op.targetPath = targetPath
			operations.push(op)
		} else {
			// Unknown or blank line — skip
			i++
		}
	}

	return operations
}

// ─── Applying patches to file content ────────────────────────────────────────

/**
 * Compute replacements for all chunks, tracking position across chunks.
 * Each replacement is [startIndex, oldLength, newLines[]]
 */
function computeReplacements(originalLines: string[], chunks: PatchChunk[]): Array<[number, number, string[]]> {
	const replacements: Array<[number, number, string[]]> = []
	let lineIndex = 0

	for (const chunk of chunks) {
		// Handle context-based seeking from @@ header
		if (chunk.changeContext) {
			const contextIdx = seekSequence(originalLines, [chunk.changeContext], lineIndex)
			if (contextIdx === -1) {
				throw new Error(`Failed to find context '${chunk.changeContext}' in file`)
			}
			lineIndex = contextIdx + 1
		}

		// Handle pure addition (no old lines)
		if (chunk.oldLines.length === 0) {
			const insertionIdx =
				originalLines.length > 0 && originalLines[originalLines.length - 1] === ''
					? originalLines.length - 1
					: originalLines.length
			replacements.push([insertionIdx, 0, chunk.newLines])
			continue
		}

		// Try to match old lines in the file
		let pattern = chunk.oldLines
		let newSlice = chunk.newLines
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.endOfFile)

		// Retry without trailing empty line if not found
		if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === '') {
			pattern = pattern.slice(0, -1)
			if (newSlice.length > 0 && newSlice[newSlice.length - 1] === '') {
				newSlice = newSlice.slice(0, -1)
			}
			found = seekSequence(originalLines, pattern, lineIndex, chunk.endOfFile)
		}

		if (found !== -1) {
			replacements.push([found, pattern.length, newSlice])
			lineIndex = found + pattern.length
		} else {
			throw new Error(`Failed to find expected lines in file:\n${chunk.oldLines.slice(0, 3).join('\n')}`)
		}
	}

	// Sort replacements by index
	replacements.sort((a, b) => a[0] - b[0])

	return replacements
}

/**
 * Apply replacements in reverse order to avoid index shifting.
 */
function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
	const result = [...lines]

	for (let i = replacements.length - 1; i >= 0; i--) {
		const [startIdx, oldLen, newSegment] = replacements[i]!
		result.splice(startIdx, oldLen, ...newSegment)
	}

	return result
}

/**
 * Apply all update chunks in order to file content string, returning new content.
 */
export function applyUpdateChunks(content: string, chunks: PatchChunk[]): string {
	// Normalise line endings: work with LF internally, restore CRLF at end
	const hasCRLF = content.includes('\r\n')
	const normalised = content.replace(/\r\n/g, '\n')

	const lines = normalised.split('\n')

	// Drop trailing empty element for consistent line counting (like opencode)
	if (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop()
	}

	const replacements = computeReplacements(lines, chunks)
	const newLines = applyReplacements(lines, replacements)

	// Ensure trailing newline (like opencode)
	if (newLines.length === 0 || newLines[newLines.length - 1] !== '') {
		newLines.push('')
	}

	const result = newLines.join('\n')
	return hasCRLF ? result.replace(/\n/g, '\r\n') : result
}

// ─── High-level validate + apply ─────────────────────────────────────────────

/**
 * Validate that all update/delete hunks can be applied to the files returned
 * by `readFile`. Throws on the first validation failure.
 *
 * This is a pure read phase — no writes happen.
 */
export async function validateHunks(ops: PatchOperation[], readFile: (path: string) => Promise<string>): Promise<void> {
	for (const op of ops) {
		if (op.type === 'update' || op.type === 'move') {
			let content: string
			try {
				content = await readFile(op.filePath)
			} catch {
				throw new Error(`apply_patch verification failed: Failed to read file to update: ${op.filePath}`)
			}
			// Dry-run the chunks to ensure context lines match
			try {
				applyUpdateChunks(content, op.chunks)
			} catch (err) {
				throw new Error(`apply_patch verification failed: ${err}`)
			}
		} else if (op.type === 'delete') {
			try {
				await readFile(op.filePath)
			} catch {
				throw new Error(`apply_patch verification failed: Failed to read file to delete: ${op.filePath}`)
			}
		}
	}
}
