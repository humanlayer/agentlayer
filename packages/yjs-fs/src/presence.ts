import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { EntryId } from './types'

const PRESENCE_FIELD = 'presence'
const SELECTION_FIELD = 'selection'

const PALETTE = [
	'hsl(210, 80%, 60%)',
	'hsl(35, 90%, 60%)',
	'hsl(150, 70%, 55%)',
	'hsl(330, 80%, 65%)',
	'hsl(55, 85%, 55%)',
	'hsl(275, 70%, 65%)',
	'hsl(180, 70%, 55%)',
	'hsl(0, 80%, 65%)',
	'hsl(240, 70%, 70%)',
	'hsl(15, 85%, 60%)',
	'hsl(120, 60%, 50%)',
	'hsl(300, 65%, 60%)',
	'hsl(75, 75%, 50%)',
	'hsl(195, 85%, 55%)',
	'hsl(345, 75%, 60%)',
	'hsl(255, 60%, 70%)',
] as const

type RelativePosition = ReturnType<typeof Y.createRelativePositionFromTypeIndex>

export type PresenceUser = {
	id: string
	name?: string
	color?: string
}

export type PresenceCursor = {
	entryId?: EntryId
	path?: string
	index: number
	length?: number
}

export type PresenceState = {
	user?: PresenceUser
	activeEntryId?: EntryId
	activePath?: string
	cwdEntryId?: EntryId
	cwdPath?: string
	cursor?: PresenceCursor
	[key: string]: unknown
}

export type LocalSelectionState = {
	anchor: RelativePosition
	head: RelativePosition
}

export type ResolvedPresenceSelection = {
	anchor: number
	head: number
}

export function colorFromId(id: string): string {
	let hash = 0
	for (let index = 0; index < id.length; index += 1) {
		hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0
	}

	const paletteIndex = ((hash % PALETTE.length) + PALETTE.length) % PALETTE.length
	return PALETTE[paletteIndex]!
}

export function getLocalPresenceState(awareness: Awareness): PresenceState | null {
	return normalizePresenceState(awareness.getLocalState()?.[PRESENCE_FIELD])
}

export function setLocalPresenceState(awareness: Awareness, presence: PresenceState | null): void {
	awareness.setLocalStateField(PRESENCE_FIELD, presence === null ? null : normalizePresenceState(presence) ?? {})
}

export function updateLocalPresenceState(awareness: Awareness, patch: Partial<PresenceState>): PresenceState {
	const current = getLocalPresenceState(awareness) ?? {}
	const next: PresenceState = {
		...current,
		...patch,
		user: mergeNestedRecord(current.user, patch.user),
		cursor: mergeNestedRecord(current.cursor, patch.cursor),
	}
	const normalized = normalizePresenceState(next) ?? {}
	awareness.setLocalStateField(PRESENCE_FIELD, normalized)
	return normalized
}

export function setLocalSelection(
	awareness: Awareness,
	ytext: Y.Text,
	anchorOffset: number,
	headOffset: number,
): void {
	const maxIndex = ytext.length
	awareness.setLocalStateField(SELECTION_FIELD, {
		anchor: Y.createRelativePositionFromTypeIndex(ytext, clampOffset(anchorOffset, maxIndex)),
		head: Y.createRelativePositionFromTypeIndex(ytext, clampOffset(headOffset, maxIndex)),
	})
}

export function clearLocalSelection(awareness: Awareness): void {
	awareness.setLocalStateField(SELECTION_FIELD, null)
}

export function getLocalSelectionState(awareness: Awareness): LocalSelectionState | null {
	const selection = awareness.getLocalState()?.[SELECTION_FIELD]
	if (!isRecord(selection) || !('anchor' in selection) || !('head' in selection)) {
		return null
	}

	return {
		anchor: selection.anchor as RelativePosition,
		head: selection.head as RelativePosition,
	}
}

export function getLocalSelection(
	awareness: Awareness,
	ytext: Y.Text,
): ResolvedPresenceSelection | undefined {
	return resolveLocalSelectionState(ytext, getLocalSelectionState(awareness))
}

export function resolveLocalSelectionState(
	ytext: Y.Text,
	selection: LocalSelectionState | null,
): ResolvedPresenceSelection | undefined {
	if (!selection) {
		return undefined
	}

	const doc = ytext.doc
	if (!doc) {
		return undefined
	}

	try {
		const anchorPosition = Y.createAbsolutePositionFromRelativePosition(selection.anchor, doc)
		const headPosition = Y.createAbsolutePositionFromRelativePosition(selection.head, doc)

		if (!anchorPosition || !headPosition) {
			return undefined
		}

		return {
			anchor: anchorPosition.index,
			head: headPosition.index,
		}
	} catch {
		return undefined
	}
}

function normalizePresenceState(value: unknown): PresenceState | null {
	if (!isRecord(value)) {
		return null
	}

	const normalized: Record<string, unknown> = { ...value }
	const user = normalizePresenceUser(value.user)
	const cursor = normalizePresenceCursor(value.cursor)

	if (user) {
		normalized.user = user
	} else {
		delete normalized.user
	}

	if (cursor) {
		normalized.cursor = cursor
	} else {
		delete normalized.cursor
	}

	copyStringField(value, normalized, 'activeEntryId')
	copyStringField(value, normalized, 'activePath')
	copyStringField(value, normalized, 'cwdEntryId')
	copyStringField(value, normalized, 'cwdPath')

	return normalized as PresenceState
}

function normalizePresenceUser(value: unknown): PresenceUser | undefined {
	if (!isRecord(value) || typeof value.id !== 'string') {
		return undefined
	}

	const normalized: PresenceUser = {
		id: value.id,
	}

	if (typeof value.name === 'string') {
		normalized.name = value.name
	}

	if (typeof value.color === 'string') {
		normalized.color = value.color
	}

	return normalized
}

function normalizePresenceCursor(value: unknown): PresenceCursor | undefined {
	if (!isRecord(value) || typeof value.index !== 'number') {
		return undefined
	}

	const normalized: PresenceCursor = {
		index: value.index,
	}

	if (typeof value.entryId === 'string') {
		normalized.entryId = value.entryId
	}

	if (typeof value.path === 'string') {
		normalized.path = value.path
	}

	if (typeof value.length === 'number') {
		normalized.length = value.length
	}

	return normalized
}

function mergeNestedRecord<T>(current: T | undefined, patch: unknown): T | undefined {
	if (patch === undefined) {
		return current
	}

	if (!isRecord(current) || !isRecord(patch)) {
		return patch as T | undefined
	}

	return {
		...current,
		...patch,
	} as T
}

function copyStringField(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
	if (typeof source[key] === 'string') {
		target[key] = source[key]
	} else {
		delete target[key]
	}
}

function clampOffset(value: number, max: number): number {
	if (!Number.isFinite(value)) {
		return 0
	}

	return Math.min(Math.max(Math.trunc(value), 0), max)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
