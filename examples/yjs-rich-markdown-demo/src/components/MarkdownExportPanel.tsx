import { artifactFragment } from '@humanlayer/yjs-rich-markdown'
import { useEffect, useState } from 'react'
import { useArtifactSession } from '../providers/ArtifactProvider'

type MarkdownExportPanelProps = {
	path: string
}

export function MarkdownExportPanel({ path }: MarkdownExportPanelProps) {
	const { doc } = useArtifactSession()
	const [fragmentString, setFragmentString] = useState<string>('')
	const [fragmentJson, setFragmentJson] = useState<string>('')

	useEffect(() => {
		const fragment = artifactFragment(doc, path)

		const update = () => {
			setFragmentString(fragment.toString())
			setFragmentJson(formatJson(fragment.toJSON()))
		}

		update()
		fragment.observeDeep(update)
		return () => fragment.unobserveDeep(update)
	}, [doc, path])

	return (
		<div
			style={{
				padding: 12,
				background: '#f5f5f5',
				borderRadius: 4,
				fontSize: 12,
				fontFamily: 'monospace',
			}}
		>
			<h4 style={{ margin: '0 0 8px' }}>Fragment Debug: {path}</h4>
			<div style={{ marginBottom: 8, color: '#666' }}>
				Raw Y.XmlFragment serialization for agent-readable rich artifact inspection.
			</div>
			<DebugSection label="fragment.toString()" content={fragmentString} />
			<DebugSection label="fragment.toJSON()" content={fragmentJson} />
		</div>
	)
}

function DebugSection({ label, content }: { label: string; content: string }) {
	return (
		<div style={{ marginTop: 10 }}>
			<div style={{ marginBottom: 4, color: '#333', fontWeight: 700 }}>{label}</div>
			<pre
				style={{
					whiteSpace: 'pre-wrap',
					wordBreak: 'break-word',
					background: '#fff',
					padding: 8,
					borderRadius: 4,
					margin: 0,
					maxHeight: 220,
					overflow: 'auto',
				}}
			>
				{content || '(empty fragment)'}
			</pre>
		</div>
	)
}

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2) ?? ''
}
