import { describe, expect, it } from 'vitest'
import { systemMessage, userMessage, assistantMessage } from '@humanlayer/agentlayer-core'

describe('message helpers', () => {
  it('creates a user message', () => {
    const msg = userMessage('hello')
    expect(msg).toEqual({ role: 'user', content: 'hello' })
  })

  it('creates a system message', () => {
    const msg = systemMessage('you are helpful')
    expect(msg).toEqual({ role: 'system', content: 'you are helpful' })
  })

  it('creates an assistant message', () => {
    const msg = assistantMessage('hi there')
    expect(msg).toEqual({ role: 'assistant', content: 'hi there' })
  })
})
