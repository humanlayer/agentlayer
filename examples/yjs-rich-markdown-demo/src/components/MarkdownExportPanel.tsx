import { artifactFragment } from '@humanlayer/yjs-rich-markdown'
import { useEffect, useState } from 'react'
import { useArtifactSession } from '../providers/ArtifactProvider'

type MarkdownExportPanelProps = {
	path: string
}

export function MarkdownExportPanel({ path }: MarkdownExportPanelProps) {
	const { doc } = useArtifactSession()
	const [content, setContent] = useState<string>('')

	useEffect(() => {
		const fragment = artifactFragment(doc, path)

		const update = () => {
			const text = fragmentToPlainText(fragment)
			setContent(text)
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
			<h4 style={{ margin: '0 0 8px' }}>Content Export: {path}</h4>
			<div style={{ marginBottom: 8, color: '#666' }}>
				(Currently showing plain text from Y.XmlFragment. Full markdown export requires TipTap serialization.)
			</div>
			<pre
				style={{
					whiteSpace: 'pre-wrap',
					wordBreak: 'break-word',
					background: '#fff',
					padding: 8,
					borderRadius: 4,
					margin: 0,
					maxHeight: 200,
					overflow: 'auto',
				}}
			>
				{content || '(empty)'}
			</pre>
		</div>
	)
}

function fragmentToPlainText(fragment: any): string {
	const parts: string[] = []

	const traverse = (node: any) => {
		if (!node) return

		if (typeof node.toString === 'function' && node._start !== undefined) {
			parts.push(node.toString())
		} else if (node.toArray) {
			for (const child of node.toArray()) {
				traverse(child)
			}
		}
	}

	traverse(fragment)
	return parts.join('')
}
