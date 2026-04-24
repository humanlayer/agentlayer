export type EditorType = 'tiptap' | 'monaco' | 'image' | 'none'

const TIPTAP_EXTENSIONS = new Set(['.md', '.txt', '.markdown'])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp'])

const MONACO_EXTENSIONS = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.json',
	'.css',
	'.scss',
	'.less',
	'.html',
	'.xml',
	'.yaml',
	'.yml',
	'.toml',
	'.py',
	'.rb',
	'.go',
	'.rs',
	'.java',
	'.c',
	'.cpp',
	'.h',
	'.hpp',
	'.sh',
	'.bash',
	'.zsh',
	'.sql',
	'.graphql',
	'.vue',
	'.svelte',
])

export function getExtension(path: string): string {
	const lastDot = path.lastIndexOf('.')
	if (lastDot === -1 || lastDot === path.length - 1) return ''
	return path.slice(lastDot).toLowerCase()
}

export function getEditorType(path: string): EditorType {
	const ext = getExtension(path)

	if (IMAGE_EXTENSIONS.has(ext)) return 'image'
	if (TIPTAP_EXTENSIONS.has(ext)) return 'tiptap'
	if (MONACO_EXTENSIONS.has(ext)) return 'monaco'
	if (ext === '') return 'none'

	return 'monaco'
}

export function getMonacoLanguage(path: string): string {
	const ext = getExtension(path)

	const languageMap: Record<string, string> = {
		'.ts': 'typescript',
		'.tsx': 'typescript',
		'.js': 'javascript',
		'.jsx': 'javascript',
		'.json': 'json',
		'.css': 'css',
		'.scss': 'scss',
		'.less': 'less',
		'.html': 'html',
		'.xml': 'xml',
		'.yaml': 'yaml',
		'.yml': 'yaml',
		'.toml': 'toml',
		'.py': 'python',
		'.rb': 'ruby',
		'.go': 'go',
		'.rs': 'rust',
		'.java': 'java',
		'.c': 'c',
		'.cpp': 'cpp',
		'.h': 'c',
		'.hpp': 'cpp',
		'.sh': 'shell',
		'.bash': 'shell',
		'.zsh': 'shell',
		'.sql': 'sql',
		'.graphql': 'graphql',
		'.vue': 'vue',
		'.svelte': 'svelte',
		'.md': 'markdown',
		'.markdown': 'markdown',
	}

	return languageMap[ext] || 'plaintext'
}
