import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import monacoEditorPluginModule from 'vite-plugin-monaco-editor'

const monacoEditorPlugin = (monacoEditorPluginModule as any).default || monacoEditorPluginModule

export default defineConfig({
	plugins: [TanStackRouterVite(), react(), monacoEditorPlugin({})],
	define: {
		// Polyfill process.nextTick for fastq (used by @durable-streams/client)
		'process.nextTick': '((fn) => setTimeout(fn, 0))',
	},
	server: {
		port: 5175,
		strictPort: true,
		// HMR through Caddy reverse proxy
		hmr: {
			host: 'localhost',
			clientPort: 4000,
			protocol: 'wss',
		},
	},
})
