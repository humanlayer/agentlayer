import type { YjsProvider } from '@durable-streams/y-durable-streams'
import { useFilesystemRawYDoc, useYjsAwareness, useYjsProvider, useYTextForFile } from '@humanlayer/yjs-fs-react'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect } from 'react'

type TipTapEditorProps = {
	path: string
}

export function TipTapEditor({ path }: TipTapEditorProps) {
	const provider = useYjsProvider<YjsProvider>()
	const awareness = useYjsAwareness()
	const doc = useFilesystemRawYDoc()
	const ytext = useYTextForFile(path)

	if (!provider) {
		throw new Error('Provider is not available in the current Yjs filesystem session')
	}

	const localUser = awareness.getLocalState()?.user as { name: string; color: string } | undefined

	const editor = useEditor(
		{
			extensions: [
				StarterKit.configure({
					history: false,
				}),
				Collaboration.configure({
					document: doc,
					field: ytext ? undefined : undefined,
				}),
				CollaborationCursor.configure({
					provider: provider as any,
					user: localUser || { name: 'Anonymous', color: '#888888' },
				}),
			],
			content: '',
			editorProps: {
				attributes: {
					style: "height: 100%; padding: 16px; outline: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;",
				},
			},
		},
		[path],
	)

	useEffect(() => {
		if (editor && ytext) {
			const content = ytext.toString()
			if (editor.getText() !== content) {
				editor.commands.setContent(content)
			}

			const observer = () => {
				const newContent = ytext.toString()
				if (editor.getText() !== newContent) {
					editor.commands.setContent(newContent)
				}
			}

			ytext.observe(observer)
			return () => ytext.unobserve(observer)
		}
	}, [editor, ytext])

	useEffect(() => {
		if (editor && ytext) {
			const handler = ({ editor: e }: any) => {
				const text = e.getText()
				const currentText = ytext.toString()
				if (text !== currentText) {
					doc.transact(() => {
						ytext.delete(0, ytext.length)
						if (text.length > 0) {
							ytext.insert(0, text)
						}
					})
				}
			}

			editor.on('update', handler)
			return () => {
				editor.off('update', handler)
			}
		}
	}, [editor, ytext, doc])

	if (!ytext) {
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
				Loading editor...
			</div>
		)
	}

	return (
		<div style={{ height: '100%', overflow: 'auto' }}>
			<EditorContent editor={editor} style={{ height: '100%' }} />
		</div>
	)
}
