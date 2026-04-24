import { useFilesystemRawYDoc, useYjsAwareness, useYTextForFile } from '@humanlayer/yjs-fs-react'
import * as monaco from 'monaco-editor'
import { useEffect, useRef } from 'react'
import { MonacoBinding } from 'y-monaco'
import { useMonacoAwareness } from '../hooks/useMonacoAwareness'
import { getMonacoLanguage } from '../lib/file-types'

type MonacoEditorProps = {
	path: string
}

export function MonacoEditor({ path }: MonacoEditorProps) {
	const containerRef = useRef<HTMLDivElement>(null)
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
	const bindingRef = useRef<MonacoBinding | null>(null)
	const awareness = useYjsAwareness()
	const doc = useFilesystemRawYDoc()
	const ytext = useYTextForFile(path)

	useMonacoAwareness(awareness, doc)

	useEffect(() => {
		if (!containerRef.current || !ytext) return

		const editor = monaco.editor.create(containerRef.current, {
			value: '',
			language: getMonacoLanguage(path),
			theme: 'vs-dark',
			automaticLayout: true,
			minimap: { enabled: false },
			fontSize: 14,
			lineNumbers: 'on',
			scrollBeyondLastLine: false,
			wordWrap: 'on',
			tabSize: 2,
		})

		editorRef.current = editor

		const binding = new MonacoBinding(ytext, editor.getModel()!, new Set([editor]), awareness)

		bindingRef.current = binding

		return () => {
			binding.destroy()
			editor.dispose()
			editorRef.current = null
			bindingRef.current = null
		}
	}, [path, ytext, awareness])

	useEffect(() => {
		if (editorRef.current) {
			const model = editorRef.current.getModel()
			if (model) {
				monaco.editor.setModelLanguage(model, getMonacoLanguage(path))
			}
		}
	}, [path])

	if (!ytext) {
		return (
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					height: '100%',
					color: '#666',
					backgroundColor: '#1e1e1e',
				}}
			>
				Loading editor...
			</div>
		)
	}

	return <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
}
