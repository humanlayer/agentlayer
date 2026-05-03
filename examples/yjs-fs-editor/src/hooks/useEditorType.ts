import { useMemo } from 'react'
import { type EditorType, getEditorType } from '../lib/file-types'

export function useEditorType(path: string): EditorType {
	return useMemo(() => getEditorType(path), [path])
}
