import { useEntryStat } from '@humanlayer/yjs-fs-react'
import { useEditorType } from '../hooks/useEditorType'
import { ImagePreview } from './ImagePreview'
import { MonacoEditor } from './MonacoEditor'
import { TipTapEditor } from './TipTapEditor'

type EditorPaneProps = {
	path: string
}

export function EditorPane({ path }: EditorPaneProps) {
	const stat = useEntryStat(path)
	const editorType = useEditorType(path)
	const fileExists = stat !== null
	const isDirectory = stat?.isDirectory ?? false

	if (!fileExists) {
		return (
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					height: '100%',
					color: '#666',
				}}
			>
				<div style={{ textAlign: 'center' }}>
					<div style={{ fontSize: '48px', marginBottom: '16px' }}>📄</div>
					<div>File not found: {path}</div>
				</div>
			</div>
		)
	}

	if (isDirectory) {
		return (
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					height: '100%',
					color: '#666',
				}}
			>
				<div style={{ textAlign: 'center' }}>
					<div style={{ fontSize: '48px', marginBottom: '16px' }}>📁</div>
					<div>Select a file to edit</div>
					<div style={{ fontSize: '14px', marginTop: '8px' }}>{path}</div>
				</div>
			</div>
		)
	}

	if (editorType === 'image') {
		return <ImagePreview path={path} />
	}

	if (editorType === 'tiptap') {
		return <TipTapEditor path={path} />
	}

	if (editorType === 'monaco') {
		return <MonacoEditor path={path} />
	}

	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				height: '100%',
				color: '#666',
			}}
		>
			<div style={{ textAlign: 'center' }}>
				<div style={{ fontSize: '48px', marginBottom: '16px' }}>❓</div>
				<div>Unknown file type</div>
				<div style={{ fontSize: '14px', marginTop: '8px' }}>{path}</div>
			</div>
		</div>
	)
}
