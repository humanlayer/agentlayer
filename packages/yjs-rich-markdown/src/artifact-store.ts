import * as Y from 'yjs'
import { type ArtifactPath, artifactFragmentName, normalizeArtifactPath } from './artifact-path'

export type ArtifactMetadata = {
	path: ArtifactPath
	title?: string
	createdAt: number
	modifiedAt: number
}

export type CreateArtifactOptions = {
	title?: string
	now?: number
}

const REGISTRY_NAME = 'artifacts'

export class RichMarkdownArtifactStore {
	readonly doc: Y.Doc
	readonly registry: Y.Map<ArtifactMetadata>

	constructor(doc = new Y.Doc()) {
		this.doc = doc
		this.registry = doc.getMap<ArtifactMetadata>(REGISTRY_NAME)
	}

	createArtifact(path: string, options: CreateArtifactOptions = {}): ArtifactMetadata {
		const normalizedPath = normalizeArtifactPath(path)
		const existing = this.registry.get(normalizedPath)
		if (existing) {
			throw new ArtifactAlreadyExistsError(normalizedPath)
		}

		const now = options.now ?? Date.now()
		const metadata: ArtifactMetadata = {
			path: normalizedPath,
			title: options.title,
			createdAt: now,
			modifiedAt: now,
		}

		this.doc.transact(() => {
			this.registry.set(normalizedPath, metadata)
			this.doc.getXmlFragment(artifactFragmentName(normalizedPath))
		})

		return metadata
	}

	ensureArtifact(path: string, options: CreateArtifactOptions = {}): ArtifactMetadata {
		const normalizedPath = normalizeArtifactPath(path)
		return this.registry.get(normalizedPath) ?? this.createArtifact(normalizedPath, options)
	}

	getArtifact(path: string): ArtifactMetadata {
		const normalizedPath = normalizeArtifactPath(path)
		const metadata = this.registry.get(normalizedPath)
		if (!metadata) {
			throw new ArtifactNotFoundError(normalizedPath)
		}
		return metadata
	}

	listArtifacts(): ArtifactMetadata[] {
		return Array.from(this.registry.values()).sort((a, b) => a.path.localeCompare(b.path))
	}

	getFragment(path: string): Y.XmlFragment {
		const normalizedPath = normalizeArtifactPath(path)
		return this.doc.getXmlFragment(artifactFragmentName(normalizedPath))
	}
}

export class ArtifactAlreadyExistsError extends Error {
	constructor(readonly path: ArtifactPath) {
		super(`Artifact already exists: ${path}`)
		this.name = 'ArtifactAlreadyExistsError'
	}
}

export class ArtifactNotFoundError extends Error {
	constructor(readonly path: ArtifactPath) {
		super(`Artifact not found: ${path}`)
		this.name = 'ArtifactNotFoundError'
	}
}
