import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import type { ContentStore } from './content-store'
import {
	clearLocalSelection,
	getLocalPresenceState,
	getLocalSelection,
	type PresenceState,
	type ResolvedPresenceSelection,
	setLocalPresenceState,
	setLocalSelection,
	updateLocalPresenceState,
} from './presence'
import type { ContentId } from './types'

export class PresenceStore {
	private awareness: Awareness | null

	constructor(awareness: Awareness | null = null) {
		this.awareness = awareness
	}

	getAwareness(): Awareness | null {
		return this.awareness
	}

	setAwareness(awareness: Awareness | null): void {
		this.awareness = awareness
	}

	getLocalPresence(): PresenceState | null {
		if (!this.awareness) {
			return null
		}

		return getLocalPresenceState(this.awareness)
	}

	setLocalPresence(presence: PresenceState | null): void {
		if (!this.awareness) {
			return
		}

		setLocalPresenceState(this.awareness, presence)
	}

	updateLocalPresence(patch: Partial<PresenceState>): PresenceState | null {
		if (!this.awareness) {
			return null
		}

		return updateLocalPresenceState(this.awareness, patch)
	}

	setLocalSelection(text: Y.Text, anchorOffset: number, headOffset: number): void {
		if (!this.awareness) {
			return
		}

		setLocalSelection(this.awareness, text, anchorOffset, headOffset)
	}

	setLocalSelectionForContent(
		contentStore: ContentStore,
		contentId: ContentId,
		pathForErrors: string,
		anchorOffset: number,
		headOffset: number,
	): void {
		this.setLocalSelection(contentStore.getText(contentId, pathForErrors), anchorOffset, headOffset)
	}

	clearLocalSelection(): void {
		if (!this.awareness) {
			return
		}

		clearLocalSelection(this.awareness)
	}

	getLocalSelection(text: Y.Text): ResolvedPresenceSelection | undefined {
		if (!this.awareness) {
			return undefined
		}

		return getLocalSelection(this.awareness, text)
	}

	getLocalSelectionForContent(
		contentStore: ContentStore,
		contentId: ContentId,
		pathForErrors: string,
	): ResolvedPresenceSelection | undefined {
		return this.getLocalSelection(contentStore.getText(contentId, pathForErrors))
	}
}
