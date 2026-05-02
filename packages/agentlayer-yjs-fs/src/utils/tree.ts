import type { FilesystemTreeNode } from '@humanlayer/yjs-fs'
import { minimatch } from 'minimatch'

export function flattenTree(node: FilesystemTreeNode, opts: { filesOnly?: boolean } = {}): string[] {
	const paths: string[] = []

	function visit(current: FilesystemTreeNode) {
		if (current.path !== '/' && (!opts.filesOnly || current.type === 'file')) {
			paths.push(current.path)
		}

		for (const child of current.children ?? []) {
			visit(child)
		}
	}

	visit(node)
	return paths
}

export function matchGlob(path: string, pattern: string): boolean {
	const normalizedPath = path.startsWith('/') ? path.slice(1) : path
	const normalizedPattern = pattern.startsWith('/') ? pattern.slice(1) : pattern
	return minimatch(normalizedPath, normalizedPattern, { dot: true })
}
