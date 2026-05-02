import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [TanStackRouterVite(), react()],
	resolve: {
		conditions: ['source'],
	},
	server: {
		port: 5176,
		strictPort: true,
		proxy: {
			'/v1/yjs': {
				target: 'http://127.0.0.1:4438',
				changeOrigin: true,
			},
		},
	},
})
