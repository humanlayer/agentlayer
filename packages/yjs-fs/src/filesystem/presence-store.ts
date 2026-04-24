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

/**
 * Adapter around Yjs awareness for presence and file-local text selection.
 *
 * This store keeps awareness optional and bridges path/content based filesystem
 * APIs to the lower-level helpers that operate on `Awareness` and `Y.Text`.
 */
export class PresenceStore {
	private awareness: Awareness | null

	/** Creates a store with an optional initial awareness instance. */
	constructor(awareness: Awareness | null = null) {
		this.awareness = awareness
	}

	/** Returns the currently bound awareness instance, if any. */
	getAwareness(): Awareness | null {
		return this.awareness
	}

	/** Replaces the awareness instance used for presence operations. */
	setAwareness(awareness: Awareness | null): void {
		this.awareness = awareness
	}

	/** Reads the normalized local presence payload from awareness. */
	getLocalPresence(): PresenceState | null {
		if (!this.awareness) {
			return null
		}

		return getLocalPresenceState(this.awareness)
	}

	/** Replaces the local presence payload in awareness. */
	setLocalPresence(presence: PresenceState | null): void {
		if (!this.awareness) {
			return
		}

		setLocalPresenceState(this.awareness, presence)
	}

	/** Applies a partial update to the local presence payload. */
	updateLocalPresence(patch: Partial<PresenceState>): PresenceState | null {
		if (!this.awareness) {
			return null
		}

		return updateLocalPresenceState(this.awareness, patch)
	}

	/** Stores a local text selection for a specific `Y.Text`. */
	setLocalSelection(text: Y.Text, anchorOffset: number, headOffset: number): void {
		if (!this.awareness) {
			return
		}

		setLocalSelection(this.awareness, text, anchorOffset, headOffset)
	}

	/** Resolves a content id to `Y.Text` and stores a local selection for it. */
	setLocalSelectionForContent(
		contentStore: ContentStore,
		contentId: ContentId,
		pathForErrors: string,
		anchorOffset: number,
		headOffset: number,
	): void {
		this.setLocalSelection(contentStore.getText(contentId, pathForErrors), anchorOffset, headOffset)
	}

	/** Clears the local selection stored in awareness. */
	clearLocalSelection(): void {
		if (!this.awareness) {
			return
		}

		clearLocalSelection(this.awareness)
	}

	/** Resolves the current local selection against a specific `Y.Text`. */
	getLocalSelection(text: Y.Text): ResolvedPresenceSelection | undefined {
		if (!this.awareness) {
			return undefined
		}

		return getLocalSelection(this.awareness, text)
	}

	/** Resolves the current local selection for a file addressed by content id. */
	getLocalSelectionForContent(
		contentStore: ContentStore,
		contentId: ContentId,
		pathForErrors: string,
	): ResolvedPresenceSelection | undefined {
		return this.getLocalSelection(contentStore.getText(contentId, pathForErrors))
	}
}
