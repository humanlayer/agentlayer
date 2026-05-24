import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@humanlayer/agentlayer-core': resolve(__dirname, 'packages/agentlayer-core/src'),
      '@humanlayer/agentlayer-filesystem': resolve(__dirname, 'packages/agentlayer-filesystem/src'),
      '@humanlayer/agentlayer-justbash': resolve(__dirname, 'packages/agentlayer-justbash/src'),
      '@humanlayer/agentlayer-provider-auth': resolve(__dirname, 'packages/agentlayer-provider-auth/src'),
      '@humanlayer/agentlayer-provider-github-copilot': resolve(__dirname, 'packages/agentlayer-provider-github-copilot/src'),
      '@humanlayer/agentlayer-provider-openai-codex': resolve(__dirname, 'packages/agentlayer-provider-openai-codex/src'),
      '@humanlayer/agentlayer-yjs-fs': resolve(__dirname, 'packages/agentlayer-yjs-fs/src'),
      '@humanlayer/agentlayer-yjs-fs-justbash': resolve(__dirname, 'packages/agentlayer-yjs-fs-justbash/src'),
      '@humanlayer/agentlayer-yjs-fs-secure-exec': resolve(__dirname, 'packages/agentlayer-yjs-fs-secure-exec/src'),
      '@humanlayer/yjs-fs': resolve(__dirname, 'packages/yjs-fs/src'),
      '@humanlayer/yjs-fs-react': resolve(__dirname, 'packages/yjs-fs-react/src'),
    },
  },
  test: {
    globals: true,
    include: ['packages/*/test/**/*.vitest.ts', 'agents/*/test/**/*.vitest.ts'],
  },
})
