import { defineConfig } from 'vitepress'
import llmstxt from 'vitepress-plugin-llms'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(
	defineConfig({
		title: 'AgentLayer',
		description: 'A model-agnostic toolkit for building LLM-powered coding agents.',
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
			nav: [
				{ text: 'Guide', link: '/' },
				{ text: 'GitHub', link: 'https://github.com/humanlayer/agentlayer' },
			],
			sidebar: [
				{
					text: 'Getting Started',
					items: [
						{ text: 'Overview', link: '/' },
						{ text: 'Why AgentLayer?', link: '/introduction/motivation' },
						{ text: 'Architecture', link: '/introduction/architecture' },
					],
				},
				{
					text: 'Concepts',
					items: [
						{ text: 'Tools', link: '/concepts/tools' },
						{ text: 'Hooks', link: '/concepts/hooks' },
						{ text: 'Run API', link: '/concepts/run-api' },
						{ text: 'Output Streaming', link: '/concepts/streaming' },
						{ text: 'State', link: '/concepts/state' },
						{ text: 'Subagents', link: '/concepts/subagents' },
					],
				},
				{
					text: 'agentlayer-core',
					collapsed: true,
					items: [
						{ text: 'Overview', link: '/packages/core/' },
						{ text: 'Agent', link: '/packages/core/agent' },
						{ text: 'Tool Definition', link: '/packages/core/tool-definition' },
						{ text: 'Tool Interfaces', link: '/packages/core/tool-interfaces' },
						{ text: 'Hooks', link: '/packages/core/hooks' },
						{ text: 'Prompts', link: '/packages/core/prompts' },
						{ text: 'Stop Conditions', link: '/packages/core/stop-conditions' },
						{ text: 'Token Usage', link: '/packages/core/token-usage' },
					],
				},
				{
					text: 'agentlayer-filesystem',
					collapsed: true,
					items: [
						{ text: 'Overview', link: '/packages/filesystem/' },
						{ text: 'Tools', link: '/packages/filesystem/tools' },
						{ text: 'Toolsets', link: '/packages/filesystem/toolsets' },
						{ text: 'Skills', link: '/packages/filesystem/skills' },
						{ text: 'Subagents', link: '/packages/filesystem/subagents' },
						{ text: 'Hooks', link: '/packages/filesystem/hooks' },
					],
				},
				{
					text: 'agentlayer-justbash',
					collapsed: true,
					items: [
						{ text: 'Overview', link: '/packages/justbash/' },
						{ text: 'Tools', link: '/packages/justbash/tools' },
						{ text: 'Prompts', link: '/packages/justbash/prompts' },
					],
				},
				{
					text: 'agentlayer-provider-openai-codex',
					collapsed: true,
					items: [{ text: 'Overview', link: '/packages/openai-codex/' }],
				},
				{
					text: 'Guides',
					collapsed: true,
					items: [
						{ text: 'Building Your First Agent', link: '/guides/first-agent' },
						{ text: 'Custom Tools', link: '/guides/custom-tools' },
						{ text: 'Hook Patterns', link: '/guides/hook-patterns' },
						{ text: 'Multi-Model Support', link: '/guides/multi-model' },
					],
				},
			],
			socialLinks: [{ icon: 'github', link: 'https://github.com/humanlayer/agentlayer' }],
		},
		mermaid: {},
		mermaidPlugin: {
			class: 'mermaid agentlayer-mermaid',
		},
	}),
)
