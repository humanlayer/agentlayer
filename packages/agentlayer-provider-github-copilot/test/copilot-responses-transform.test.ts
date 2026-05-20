import { describe, expect, test } from 'bun:test'
import { convertToOpenAIResponsesInput } from '../src/sdk/copilot/responses/convert-to-openai-responses-input'

describe('convertToOpenAIResponsesInput', () => {
	test('serializes multimodal tool outputs for responses requests', async () => {
		const result = await convertToOpenAIResponsesInput({
			prompt: [
				{
					role: 'tool',
					content: [
						{
							type: 'tool-result',
							toolCallId: 'call_image',
							toolName: 'read',
							output: {
								type: 'content',
								value: [
									{ type: 'text', text: 'Read image.png' },
									{ type: 'image-data', data: 'iVBORw0KGgo=', mediaType: 'image/png' },
									{ type: 'file-data', data: 'JVBERi0=', mediaType: 'application/pdf', filename: 'doc.pdf' },
								],
							},
						},
					],
				},
			],
			systemMessageMode: 'system',
			store: false,
		})

		expect(result.input).toEqual([
			{
				type: 'function_call_output',
				call_id: 'call_image',
				output: [
					{ type: 'input_text', text: 'Read image.png' },
					{ type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
					{ type: 'input_file', filename: 'doc.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
				],
			},
		])
		expect(result.warnings).toEqual([])
	})
})
