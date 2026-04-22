import { defineConfig } from 'vitepress'
import llmstxt from 'vitepress-plugin-llms'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(
	defineConfig({
		title: 'AgentLayer',
		description: 'AgentLayer is the best way to build coding agents for complex codebases.',
		markdown: {
			theme: {
				light: 'min-light',
				dark: 'github-dark',
			},
		},
		vite: {
			plugins: [
				llmstxt({
					ignoreFiles: ['meta/**'],
				}),
			],
		},
		themeConfig: {
			search: {
				provider: 'local',
			},
			nav: [],
			sidebar: [
				{
					text: 'Introduction',
					items: [
						{ text: 'Motivation', link: '/introduction/motivation' },
						{ text: 'Introduction', link: '/' },
						{ text: 'Architecture', link: '/introduction/architecture' },
					],
				},
				{
					text: 'Core Concepts',
					items: [
						{ text: 'Tools', link: '/core/tools' },
						{ text: 'Hooks', link: '/core/hooks' },
						{ text: 'State', link: '/core/state' },
						{ text: 'Run API', link: '/core/run-api' },
					],
				},
				{
					text: 'Examples',
					items: [
						{ text: 'Markdown Extension Examples', link: '/examples/markdown-examples' },
						{ text: 'Runtime API Examples', link: '/examples/api-examples' },
					],
				},
			],
		},
		mermaid: {},
		mermaidPlugin: {
			class: 'mermaid agentlayer-mermaid',
		},
	}),
)
