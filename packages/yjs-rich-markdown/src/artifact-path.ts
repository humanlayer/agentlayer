export type ArtifactPath = string

export function normalizeArtifactPath(path: string): ArtifactPath {
	const trimmed = path.trim()
	if (!trimmed) {
		throw new InvalidArtifactPathError(path, 'Artifact path must not be empty')
	}

	if (!trimmed.startsWith('/')) {
		throw new InvalidArtifactPathError(path, 'Artifact path must be absolute')
	}

	const normalized = trimmed.replace(/\/+/g, '/')
	if (
		normalized.includes('/../') ||
		normalized.endsWith('/..') ||
		normalized.includes('/./') ||
		normalized.endsWith('/.')
	) {
		throw new InvalidArtifactPathError(path, 'Artifact path must not contain relative segments')
	}

	return normalized
}

export function artifactFragmentName(path: ArtifactPath): string {
	return `artifact:${normalizeArtifactPath(path)}`
}

export class InvalidArtifactPathError extends Error {
	constructor(
		readonly path: string,
		message: string,
	) {
		super(message)
		this.name = 'InvalidArtifactPathError'
	}
}
