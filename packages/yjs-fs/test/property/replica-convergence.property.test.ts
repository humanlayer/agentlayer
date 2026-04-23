import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import fc from 'fast-check'
import * as Y from 'yjs'
import { snapshotFilesystem } from '../util/snapshot'
import { syncBothWays } from '../util/sync'

type Replica = 'a' | 'b'

type Operation =
	| { kind: 'mkdir'; replica: Replica; path: string }
	| { kind: 'createFile'; replica: Replica; path: string; content: string }
	| { kind: 'writeFile'; replica: Replica; path: string; content: string }
	| { kind: 'editFile'; replica: Replica; path: string }
	| { kind: 'rename'; replica: Replica; fromPath: string; toPath: string }
	| { kind: 'unlink'; replica: Replica; path: string }
	| { kind: 'sync' }

const PROPERTY_SEED = 992211

describe('YjsFilesystem replica convergence properties', () => {
	test('replicas converge after adversarial interleavings and sync rounds', () => {
		fc.assert(
			fc.property(fc.array(operationArbitrary(), { minLength: 1, maxLength: 50 }), (operations) => {
				const docA = new Y.Doc()
				const docB = new Y.Doc()
				const fsA = new YjsFilesystem({ doc: docA })
				const fsB = new YjsFilesystem({ doc: docB })

				for (const operation of operations) {
					applyOperation(operation, fsA, fsB, docA, docB)
				}

				syncBothWays(docA, docB)
				expect(snapshotFilesystem(fsA)).toEqual(snapshotFilesystem(fsB))
			}),
			{
				seed: PROPERTY_SEED,
				numRuns: 100,
				verbose: 2,
			},
		)
	})
})

function applyOperation(operation: Operation, fsA: YjsFilesystem, fsB: YjsFilesystem, docA: Y.Doc, docB: Y.Doc): void {
	if (operation.kind === 'sync') {
		syncBothWays(docA, docB)
		expect(snapshotFilesystem(fsA)).toEqual(snapshotFilesystem(fsB))
		return
	}

	const filesystem = operation.replica === 'a' ? fsA : fsB

	switch (operation.kind) {
		case 'mkdir': {
			if (canCreateAtPath(filesystem, operation.path)) {
				filesystem.mkdir(operation.path)
			}
			break
		}
		case 'createFile': {
			if (canCreateAtPath(filesystem, operation.path)) {
				filesystem.createFile(operation.path, operation.content)
			}
			break
		}
		case 'writeFile': {
			if (isFile(filesystem, operation.path)) {
				filesystem.writeFile(operation.path, operation.content)
			}
			break
		}
		case 'editFile': {
			if (!isFile(filesystem, operation.path)) {
				break
			}

			const content = filesystem.readFile(operation.path)
			if (content.length === 0) {
				break
			}

			const needle = content.slice(0, Math.max(1, Math.min(3, content.length)))
			if (content.indexOf(needle) !== content.lastIndexOf(needle)) {
				break
			}

			filesystem.editFile(operation.path, needle, `${needle}!`)
			break
		}
		case 'rename': {
			if (
				!filesystem.exists(operation.fromPath) ||
				filesystem.exists(operation.toPath) ||
				!parentIsDirectory(filesystem, operation.toPath)
			) {
				break
			}

			if (operation.toPath.startsWith(`${operation.fromPath}/`)) {
				break
			}

			filesystem.rename(operation.fromPath, operation.toPath)
			break
		}
		case 'unlink': {
			if (!filesystem.exists(operation.path) || operation.path === '/') {
				break
			}

			if (isDirectory(filesystem, operation.path) && filesystem.list(operation.path).length > 0) {
				break
			}

			filesystem.unlink(operation.path)
			break
		}
	}
}

function operationArbitrary(): fc.Arbitrary<Operation> {
	return fc.oneof(
		fc
			.record({ replica: replicaArbitrary(), path: pathArbitrary('dir') })
			.map(({ replica, path }) => ({ kind: 'mkdir' as const, replica, path })),
		fc
			.record({ replica: replicaArbitrary(), path: pathArbitrary('file'), content: fc.string({ maxLength: 12 }) })
			.map(({ replica, path, content }) => ({ kind: 'createFile' as const, replica, path, content })),
		fc
			.record({
				replica: replicaArbitrary(),
				path: pathArbitrary('write'),
				content: fc.string({ maxLength: 12 }),
			})
			.map(({ replica, path, content }) => ({ kind: 'writeFile' as const, replica, path, content })),
		fc
			.record({ replica: replicaArbitrary(), path: pathArbitrary('edit') })
			.map(({ replica, path }) => ({ kind: 'editFile' as const, replica, path })),
		fc
			.record({ replica: replicaArbitrary(), fromPath: pathArbitrary('from'), toPath: pathArbitrary('to') })
			.map(({ replica, fromPath, toPath }) => ({ kind: 'rename' as const, replica, fromPath, toPath })),
		fc
			.record({ replica: replicaArbitrary(), path: pathArbitrary('delete') })
			.map(({ replica, path }) => ({ kind: 'unlink' as const, replica, path })),
		fc.constant({ kind: 'sync' as const }),
	)
}

function replicaArbitrary(): fc.Arbitrary<Replica> {
	return fc.constantFrom('a', 'b')
}

function pathArbitrary(label: string): fc.Arbitrary<string> {
	return fc.array(segmentArbitrary(label), { minLength: 1, maxLength: 3 }).map((segments) => `/${segments.join('/')}`)
}

function segmentArbitrary(label: string): fc.Arbitrary<string> {
	return fc.constantFrom(`${label}-a`, `${label}-b`, `${label}-c`, `${label}-d`)
}

function canCreateAtPath(filesystem: YjsFilesystem, path: string): boolean {
	return !filesystem.exists(path) && parentIsDirectory(filesystem, path)
}

function parentIsDirectory(filesystem: YjsFilesystem, path: string): boolean {
	const parentPath = dirname(path)
	return isDirectory(filesystem, parentPath)
}

function isDirectory(filesystem: YjsFilesystem, path: string): boolean {
	const lookup = filesystem.lookup(path)
	return lookup?.entry.type === 'directory'
}

function isFile(filesystem: YjsFilesystem, path: string): boolean {
	const lookup = filesystem.lookup(path)
	return lookup?.entry.type === 'file'
}

function dirname(path: string): string {
	if (path === '/') {
		return '/'
	}

	const parts = path.split('/').filter(Boolean)
	if (parts.length <= 1) {
		return '/'
	}

	return `/${parts.slice(0, -1).join('/')}`
}
