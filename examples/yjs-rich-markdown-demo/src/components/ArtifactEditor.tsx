import { artifactCollaborationExtension } from '@humanlayer/yjs-rich-markdown'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect } from 'react'
import { useArtifactSession } from '../providers/ArtifactProvider'

type ArtifactEditorProps = {
	path: string
	mode?: 'fragment' | 'field'
}

export function ArtifactEditor({ path, mode = 'fragment' }: ArtifactEditorProps) {
	const { doc, store, awareness, provider, localUser } = useArtifactSession()

	store.ensureArtifact(path)

	const editor = useEditor(
		{
			extensions: [
				StarterKit.configure({
					undoRedo: false,
				}),
				artifactCollaborationExtension({ doc, path, mode }),
				CollaborationCaret.configure({
					provider: provider as any,
					user: {
						name: localUser.name,
						color: localUser.color,
					},
				}),
			],
			editorProps: {
				attributes: {
					class: 'tiptap',
				},
			},
		},
		[path, mode],
	)

	useEffect(() => {
		awareness.setLocalStateField('presence', { artifactPath: path })

		return () => {
			awareness.setLocalStateField('presence', { artifactPath: undefined })
		}
	}, [path, awareness])

	useEffect(() => {
		return () => {
			editor?.destroy()
		}
	}, [editor])

	return (
		<div
			style={{
				border: '1px solid #e0e0e0',
				borderRadius: 4,
				background: '#fff',
				height: '100%',
				overflow: 'auto',
			}}
		>
			<EditorContent editor={editor} style={{ height: '100%' }} />
		</div>
	)
}
