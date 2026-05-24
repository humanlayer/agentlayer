import z from 'zod'
import { defineToolInterface } from '../define-tool'
import { type ReadInput, ReadTool, readInput } from './read'

export type ModelsDevModality = 'image' | 'audio' | 'video' | 'pdf'
export type ReadToolModalities = readonly ['text', ...ModelsDevModality[]]

export type ReadMultimodalOutput =
	| { type: 'text'; content: string }
	| { type: 'image'; content: Uint8Array; mediaType: string }
	| { type: 'pdf'; content: Uint8Array; mediaType: 'application/pdf' }

const uint8ArraySchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'Expected Uint8Array')

export const readMultimodalOutput = z.discriminatedUnion('type', [
	z.object({ type: z.literal('text'), content: z.string() }),
	z.object({ type: z.literal('image'), content: uint8ArraySchema, mediaType: z.string() }),
	z.object({ type: z.literal('pdf'), content: uint8ArraySchema, mediaType: z.literal('application/pdf') }),
])

function bytesToBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64')
}

export const ReadMultimodalTool = defineToolInterface<ReadInput, ReadMultimodalOutput>({
	name: 'read',
	description: 'Read a file with line numbers or multimodal content',
	input: readInput,
	output: readMultimodalOutput,
	serialize: (raw, input) => {
		if (raw.type === 'text') {
			return ReadTool.serialize!(raw.content, input, {} as any)
		}

		if (raw.type === 'image') {
			return {
				type: 'content',
				value: [{ type: 'image-data', data: bytesToBase64(raw.content), mediaType: raw.mediaType }],
			}
		}

		return {
			type: 'content',
			value: [{ type: 'file-data', data: bytesToBase64(raw.content), mediaType: raw.mediaType }],
		}
	},
})
