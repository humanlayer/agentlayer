import { readFile, stat, writeFile } from 'node:fs/promises'
import { type HashlineEditInput, HashlineEditTool } from '@humanlayer/agentlayer-core/interfaces'
import { HASHLINE_EDIT_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import { computeLineHash, formatHashLine, HASHLINE_BIGRAM_RE_SRC } from '@humanlayer/agentlayer-core/utils'
import { expandPath } from '../utils/expand-path'

export const ANCHOR_REBASE_WINDOW = 5

interface HashMismatch {
	line: number
	expected: string
	actual: string
}
type Anchor = { line: number; hash: string }
type HashlineEdit =
	| { op: 'replace_range'; pos: Anchor; end: Anchor; lines: string[] }
	| { op: 'append_at'; pos: Anchor; lines: string[] }
	| { op: 'prepend_at'; pos: Anchor; lines: string[] }
	| { op: 'append_file'; lines: string[] }
	| { op: 'prepend_file'; lines: string[] }

const HASHLINE_CONTENT_SEPARATOR_RE = '[:|]'
const HASHLINE_PREFIX_RE = new RegExp(
	`^\\s*(?:>>>|>>)?\\s*(?:[+*]\\s*)?\\d+${HASHLINE_BIGRAM_RE_SRC}${HASHLINE_CONTENT_SEPARATOR_RE}`,
)
const HASHLINE_PREFIX_PLUS_RE = new RegExp(
	`^\\s*(?:>>>|>>)?\\s*\\+\\s*\\d+${HASHLINE_BIGRAM_RE_SRC}${HASHLINE_CONTENT_SEPARATOR_RE}`,
)
const DIFF_PLUS_RE = /^[+](?![+])/
const READ_TRUNCATION_NOTICE_RE = /^\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines? in (?:file|\S+))\b.*\bsel=L?\d+/

type LinePrefixStats = {
	nonEmpty: number
	hashPrefixCount: number
	diffPlusHashPrefixCount: number
	diffPlusCount: number
}

function collectLinePrefixStats(lines: string[]): LinePrefixStats {
	const stats = { nonEmpty: 0, hashPrefixCount: 0, diffPlusHashPrefixCount: 0, diffPlusCount: 0 }
	for (const line of lines) {
		if (line.length === 0) continue
		if (READ_TRUNCATION_NOTICE_RE.test(line)) continue
		stats.nonEmpty++
		if (HASHLINE_PREFIX_RE.test(line)) stats.hashPrefixCount++
		if (HASHLINE_PREFIX_PLUS_RE.test(line)) stats.diffPlusHashPrefixCount++
		if (DIFF_PLUS_RE.test(line)) stats.diffPlusCount++
	}
	return stats
}

function stripLeadingHashlinePrefixes(line: string): string {
	let result = line
	let prev: string
	do {
		prev = result
		result = result.replace(HASHLINE_PREFIX_RE, '')
	} while (result !== prev)
	return result
}

export function stripNewLinePrefixes(lines: string[]): string[] {
	const { nonEmpty, hashPrefixCount, diffPlusHashPrefixCount, diffPlusCount } = collectLinePrefixStats(lines)
	if (nonEmpty === 0) return lines
	const stripHash = hashPrefixCount > 0 && hashPrefixCount === nonEmpty
	const stripPlus =
		!stripHash && diffPlusHashPrefixCount === 0 && diffPlusCount > 0 && diffPlusCount >= nonEmpty * 0.5
	if (!stripHash && !stripPlus && diffPlusHashPrefixCount === 0) return lines
	return lines
		.filter((line) => !READ_TRUNCATION_NOTICE_RE.test(line))
		.map((line) => {
			if (stripHash) return stripLeadingHashlinePrefixes(line)
			if (stripPlus) return line.replace(DIFF_PLUS_RE, '')
			if (diffPlusHashPrefixCount > 0 && HASHLINE_PREFIX_PLUS_RE.test(line))
				return line.replace(HASHLINE_PREFIX_RE, '')
			return line
		})
}

export function hashlineParseText(edit: string[] | string | null | undefined): string[] {
	if (edit == null) return []
	if (typeof edit === 'string') {
		const normalizedEdit = edit.endsWith('\n') ? edit.slice(0, -1) : edit
		edit = normalizedEdit.replaceAll('\r', '').split('\n')
	}
	return stripNewLinePrefixes(edit)
}

export function formatFullAnchorRequirement(raw?: string): string {
	const suffix = typeof raw === 'string' ? raw.trim() : ''
	const hashOnlyHint = /^[A-Za-z]{2}$/.test(suffix)
		? ` It looks like you supplied only the 2-letter suffix (${JSON.stringify(suffix)}). Copy the full anchor exactly as shown (for example, "160${suffix}").`
		: ''
	const received = raw === undefined ? '' : ` Received ${JSON.stringify(raw)}.`
	return `the full anchor exactly as shown by read/grep (line number + 2-letter suffix, for example "160sr")${received}${hashOnlyHint}`
}

export function parseTag(ref: string): Anchor {
	const match = ref.match(new RegExp(`^\\s*[>+\\-*]*\\s*(\\d+)(${HASHLINE_BIGRAM_RE_SRC})`))
	if (!match) throw new Error(`Invalid line reference. Expected ${formatFullAnchorRequirement(ref)}.`)
	const lineText = match[1]
	const hash = match[2]
	if (!lineText || !hash) throw new Error(`Invalid line reference. Expected ${formatFullAnchorRequirement(ref)}.`)
	const line = Number.parseInt(lineText, 10)
	if (line < 1) throw new Error(`Line number must be >= 1, got ${line} in ${JSON.stringify(ref)}.`)
	return { line, hash }
}

function tryParseTag(raw: string): Anchor | undefined {
	try {
		return parseTag(raw)
	} catch {
		return undefined
	}
}

function requireParsedAnchor(raw: string, op: 'append' | 'prepend'): Anchor {
	const anchor = tryParseTag(raw)
	if (!anchor) throw new Error(`${op} requires ${formatFullAnchorRequirement(raw)}.`)
	return anchor
}

function requireParsedRange(range: { pos: string; end: string }): { pos: Anchor; end: Anchor } {
	const pos = tryParseTag(range.pos)
	const end = tryParseTag(range.end)
	if (!pos || !end) {
		const invalid = [
			!pos ? `pos=${JSON.stringify(range.pos)}` : null,
			!end ? `end=${JSON.stringify(range.end)}` : null,
		]
			.filter(Boolean)
			.join(', ')
		throw new Error(
			`range requires valid pos and end anchors. Use ${formatFullAnchorRequirement()}. Invalid: ${invalid}.`,
		)
	}
	return { pos, end }
}

function resolveEditAnchor(edit: HashlineEditInput['edits'][number]): HashlineEdit {
	const lines = hashlineParseText(edit.content)
	const loc = edit.loc
	if (loc === 'append') return { op: 'append_file', lines }
	if (loc === 'prepend') return { op: 'prepend_file', lines }
	if (!loc || typeof loc !== 'object') throw new Error(`Invalid loc value: ${JSON.stringify(loc)}`)
	if ('append' in loc) return { op: 'append_at', pos: requireParsedAnchor(loc.append, 'append'), lines }
	if ('prepend' in loc) return { op: 'prepend_at', pos: requireParsedAnchor(loc.prepend, 'prepend'), lines }
	const { pos, end } = requireParsedRange(loc.range)
	return { op: 'replace_range', pos, end, lines }
}

export class HashlineMismatchError extends Error {
	constructor(mismatches: HashMismatch[], fileLines: string[]) {
		super(formatMismatchMessage(mismatches, fileLines))
		this.name = 'HashlineMismatchError'
	}
}

function formatMismatchMessage(mismatches: HashMismatch[], fileLines: string[]): string {
	const displayLines = new Set<number>()
	for (const m of mismatches) {
		for (let line = Math.max(1, m.line - 2); line <= Math.min(fileLines.length, m.line + 2); line++)
			displayLines.add(line)
	}
	const mismatchSet = new Set(mismatches.map((m) => m.line))
	return [
		`Edit rejected: ${mismatches.length} line${mismatches.length === 1 ? ' has' : 's have'} changed since the last read (marked *).`,
		'The edit was NOT applied, please use the updated file content shown below, and issue another edit tool-call.',
		...[...displayLines]
			.sort((a, b) => a - b)
			.map((line) => `${mismatchSet.has(line) ? '*' : ' '}${formatHashLine(line, fileLines[line - 1] ?? '')}`),
	].join('\n')
}

export function tryRebaseAnchor(anchor: Anchor, fileLines: string[], window = ANCHOR_REBASE_WINDOW): number | null {
	const lo = Math.max(1, anchor.line - window)
	const hi = Math.min(fileLines.length, anchor.line + window)
	let found: number | null = null
	for (let line = lo; line <= hi; line++) {
		if (line === anchor.line) continue
		const fileLine = fileLines[line - 1]
		if (fileLine === undefined || computeLineHash(line, fileLine) !== anchor.hash) continue
		if (found !== null) return null
		found = line
	}
	return found
}

function ensureHashlineEditHasContent(edit: HashlineEdit): void {
	if (edit.lines.length === 0) edit.lines = ['']
}

function validateHashlineEditRefs(edits: HashlineEdit[], fileLines: string[], warnings: string[]): HashMismatch[] {
	const mismatches: HashMismatch[] = []
	for (const edit of edits) {
		switch (edit.op) {
			case 'replace_range':
				validateHashlineRef(edit.pos)
				validateHashlineRef(edit.end)
				if (edit.pos.line > edit.end.line)
					throw new Error(`Range start line ${edit.pos.line} must be <= end line ${edit.end.line}`)
				break
			case 'append_at':
			case 'prepend_at':
				validateHashlineRef(edit.pos)
				ensureHashlineEditHasContent(edit)
				break
			case 'append_file':
			case 'prepend_file':
				ensureHashlineEditHasContent(edit)
				break
		}
	}
	return mismatches

	function validateHashlineRef(ref: Anchor): void {
		if (ref.line < 1 || ref.line > fileLines.length)
			throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`)
		const fileLine = fileLines[ref.line - 1]
		if (fileLine === undefined)
			throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`)
		const actualHash = computeLineHash(ref.line, fileLine)
		if (actualHash === ref.hash) return
		const rebased = tryRebaseAnchor(ref, fileLines)
		if (rebased !== null) {
			const original = `${ref.line}${ref.hash}`
			ref.line = rebased
			warnings.push(
				`Auto-rebased anchor ${original} -> ${rebased}${ref.hash} (line shifted within +/-${ANCHOR_REBASE_WINDOW}; hash matched).`,
			)
			return
		}
		mismatches.push({ line: ref.line, expected: ref.hash, actual: actualHash })
	}
}

function collectBoundaryDuplicationWarning(edit: HashlineEdit, originalFileLines: string[], warnings: string[]): void {
	if (edit.op !== 'replace_range' || edit.lines.length === 0) return
	const nextSurvivingIdx = edit.end.line
	if (nextSurvivingIdx >= originalFileLines.length) return
	const nextSurvivingLine = originalFileLines[nextSurvivingIdx]
	const lastInsertedLine = edit.lines[edit.lines.length - 1]
	if (nextSurvivingLine === undefined || lastInsertedLine === undefined) return
	const trimmedNext = nextSurvivingLine.trim()
	const trimmedLast = lastInsertedLine.trim()
	if (trimmedLast.length > 0 && trimmedLast === trimmedNext) {
		const tag = formatHashLine(edit.end.line + 1, nextSurvivingLine)
		warnings.push(
			`Possible boundary duplication: your last replacement line \`${trimmedLast}\` is identical to the next surviving line ${tag}. If you meant to replace the entire block, set \`end\` to ${tag} instead.`,
		)
	}
}

function dedupeHashlineEdits(edits: HashlineEdit[]): void {
	const seenEditKeys = new Map<string, number>()
	const dedupIndices = new Set<number>()
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i]
		if (!edit) continue
		let lineKey: string
		switch (edit.op) {
			case 'replace_range':
				lineKey = `r:${edit.pos.line}:${edit.end.line}`
				break
			case 'append_at':
				lineKey = `i:${edit.pos.line}`
				break
			case 'prepend_at':
				lineKey = `ib:${edit.pos.line}`
				break
			case 'append_file':
				lineKey = 'ieof'
				break
			case 'prepend_file':
				lineKey = 'ibef'
				break
		}
		const dstKey = `${lineKey}:${edit.lines.join('\n')}`
		if (seenEditKeys.has(dstKey)) dedupIndices.add(i)
		else seenEditKeys.set(dstKey, i)
	}
	for (let i = edits.length - 1; i >= 0; i--) if (dedupIndices.has(i)) edits.splice(i, 1)
}

function getHashlineEditSortKey(edit: HashlineEdit, fileLineCount: number): { sortLine: number; precedence: number } {
	switch (edit.op) {
		case 'replace_range':
			return { sortLine: edit.end.line, precedence: 0 }
		case 'append_at':
			return { sortLine: edit.pos.line, precedence: 1 }
		case 'prepend_at':
			return { sortLine: edit.pos.line, precedence: 2 }
		case 'append_file':
			return { sortLine: fileLineCount + 1, precedence: 1 }
		case 'prepend_file':
			return { sortLine: 0, precedence: 2 }
	}
}

function applyHashlineEditToLines(
	edit: HashlineEdit,
	fileLines: string[],
	originalFileLines: string[],
	editIndex: number,
	noopEdits: Array<{ editIndex: number; loc: string; current: string }>,
	trackFirstChanged: (line: number) => void,
): void {
	switch (edit.op) {
		case 'replace_range': {
			const count = edit.end.line - edit.pos.line + 1
			const origRange = originalFileLines.slice(edit.pos.line - 1, edit.pos.line - 1 + count)
			if (count === edit.lines.length && origRange.every((line, i) => line === edit.lines[i])) {
				noopEdits.push({
					editIndex,
					loc: `${edit.pos.line}${edit.pos.hash}-${edit.end.line}${edit.end.hash}`,
					current: origRange.join('\n'),
				})
				break
			}
			fileLines.splice(edit.pos.line - 1, count, ...edit.lines)
			trackFirstChanged(edit.pos.line)
			break
		}
		case 'append_at':
			if (edit.lines.length === 0)
				noopEdits.push({
					editIndex,
					loc: `${edit.pos.line}${edit.pos.hash}`,
					current: originalFileLines[edit.pos.line - 1] ?? '',
				})
			else {
				fileLines.splice(edit.pos.line, 0, ...edit.lines)
				trackFirstChanged(edit.pos.line + 1)
			}
			break
		case 'prepend_at':
			if (edit.lines.length === 0)
				noopEdits.push({
					editIndex,
					loc: `${edit.pos.line}${edit.pos.hash}`,
					current: originalFileLines[edit.pos.line - 1] ?? '',
				})
			else {
				fileLines.splice(edit.pos.line - 1, 0, ...edit.lines)
				trackFirstChanged(edit.pos.line)
			}
			break
		case 'append_file':
			if (edit.lines.length === 0) noopEdits.push({ editIndex, loc: 'EOF', current: '' })
			else if (fileLines.length === 1 && fileLines[0] === '') {
				fileLines.splice(0, 1, ...edit.lines)
				trackFirstChanged(1)
			} else {
				fileLines.splice(fileLines.length, 0, ...edit.lines)
				trackFirstChanged(fileLines.length - edit.lines.length + 1)
			}
			break
		case 'prepend_file':
			if (edit.lines.length === 0) noopEdits.push({ editIndex, loc: 'BOF', current: '' })
			else {
				fileLines.splice(
					fileLines.length === 1 && fileLines[0] === '' ? 0 : 0,
					fileLines.length === 1 && fileLines[0] === '' ? 1 : 0,
					...edit.lines,
				)
				trackFirstChanged(1)
			}
			break
	}
}

function applyHashlineEdits(text: string, edits: HashlineEdit[]) {
	if (edits.length === 0) return { content: text, firstChangedLine: undefined, warnings: [], noopEdits: [] }
	const fileLines = text.split('\n')
	const originalFileLines = [...fileLines]
	const warnings: string[] = []
	const noopEdits: Array<{ editIndex: number; loc: string; current: string }> = []
	let firstChangedLine: number | undefined
	const mismatches = validateHashlineEditRefs(edits, fileLines, warnings)
	if (mismatches.length > 0) throw new HashlineMismatchError(mismatches, fileLines)
	edits.forEach((edit) => collectBoundaryDuplicationWarning(edit, originalFileLines, warnings))
	dedupeHashlineEdits(edits)
	const annotated = edits
		.map((edit, idx) => ({ edit, idx, ...getHashlineEditSortKey(edit, fileLines.length) }))
		.sort((a, b) => b.sortLine - a.sortLine || a.precedence - b.precedence || a.idx - b.idx)
	for (const { edit, idx } of annotated)
		applyHashlineEditToLines(edit, fileLines, originalFileLines, idx, noopEdits, (line) => {
			if (firstChangedLine === undefined || line < firstChangedLine) firstChangedLine = line
		})
	return { content: fileLines.join('\n'), firstChangedLine, warnings, noopEdits }
}

export interface HashlineEditToolOptions {
	cwd?: string
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function writeNewHashlineFile(filePath: string, input: HashlineEditInput) {
	const lines: string[] = []
	for (const edit of input.edits.filter((edit) => edit.loc != null)) {
		if (edit.loc === 'append') lines.push(...hashlineParseText(edit.content))
		else if (edit.loc === 'prepend') lines.unshift(...hashlineParseText(edit.content))
		else throw new Error(`File not found: ${input.path}`)
	}
	const content = lines.join('\n')
	await writeFile(filePath, content)
	return { content, editCount: input.edits.length, firstChangedLine: lines.length > 0 ? 1 : undefined }
}

export function createHashlineEditTool(opts: HashlineEditToolOptions = {}) {
	const { cwd } = opts
	return HashlineEditTool.define(
		async (input) => {
			const filePath = expandPath(input.path, cwd)
			const fileStat = await stat(filePath).catch((error) => {
				if (isMissingFileError(error)) return undefined
				throw error
			})
			if (!fileStat) return await writeNewHashlineFile(filePath, input)
			if (fileStat.isDirectory()) throw new Error(`Path is a directory, not a file: ${input.path}`)
			const content = await readFile(filePath, 'utf8')
			const edits = input.edits.map(resolveEditAnchor)
			const result = applyHashlineEdits(content, edits)
			await writeFile(filePath, result.content)
			return {
				content: result.content,
				editCount: edits.length,
				firstChangedLine: result.firstChangedLine,
				warnings: result.warnings.length ? result.warnings : undefined,
				noopEdits: result.noopEdits.length ? result.noopEdits : undefined,
			}
		},
		{ description: HASHLINE_EDIT_DESCRIPTION },
	)
}
