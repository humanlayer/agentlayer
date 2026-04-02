import { minimatch } from 'minimatch'

/** Normalize path: remove trailing slash, ensure leading slash, collapse double slashes */
export function normalizePath(path: string): string {
	let p = path.replace(/\/+/g, '/')
	if (!p.startsWith('/')) p = `/${p}`
	if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
	return p
}

export function dirname(path: string): string {
	const idx = path.lastIndexOf('/')
	return idx <= 0 ? '/' : path.slice(0, idx)
}

export function basename(path: string): string {
	const idx = path.lastIndexOf('/')
	return idx === -1 ? path : path.slice(idx + 1)
}

export function joinPath(...parts: string[]): string {
	return normalizePath(parts.join('/'))
}

/** Test if a path matches a glob pattern */
export function matchGlob(path: string, pattern: string): boolean {
	// Strip leading slash for matching
	const p = path.startsWith('/') ? path.slice(1) : path
	return minimatch(p, pattern)
}
