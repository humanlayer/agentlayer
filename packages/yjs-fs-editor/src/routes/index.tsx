import type { YjsProvider } from '@durable-streams/y-durable-streams'
import type { EntryDirent } from '@humanlayer/yjs-fs'
import {
	useConnectionStatus,
	useDirectoryEntries,
	useFilesystem,
	useFilesystemTree,
	useIsSynced,
	useYjsProvider,
} from '@humanlayer/yjs-fs-react'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
	component: IndexRoute,
})

function IndexRoute() {
	const fs = useFilesystem()
	const provider = useYjsProvider<YjsProvider>()
	const connectionStatus = useConnectionStatus()
	const isSynced = useIsSynced()
	const files: EntryDirent[] = useDirectoryEntries('/')
	const tree = useFilesystemTree('/')

	const createTestFile = async () => {
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
		const path = `/debug-${timestamp}.txt`
		const body = [`debug file`, `createdAt=${new Date().toISOString()}`, `path=${path}`].join('\n')
		fs.createFile(path, body)
		await provider?.flush()
	}

	return (
		<div>
			<div>connectionStatus: {connectionStatus}</div>
			<div>isSynced: {String(isSynced)}</div>
			<button onClick={createTestFile}>Create file</button>
			<h3>Root Entries</h3>
			<pre>{JSON.stringify(files, null, 2)}</pre>
			<h3>Tree</h3>
			<pre>{JSON.stringify(tree, null, 2)}</pre>
		</div>
	)
}
