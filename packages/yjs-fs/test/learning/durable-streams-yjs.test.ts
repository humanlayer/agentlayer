import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { DurableStreamTestServer } from '@durable-streams/server'
import { YjsProvider } from '@durable-streams/y-durable-streams'
import { YjsServer } from '@durable-streams/y-durable-streams/server'
import { randomUUIDv7 } from 'bun'
import * as Y from 'yjs'
import { waitForDocText, waitForSync } from '../util/wait-for'

describe('Y Durable Streams Learning Tests', () => {
	// Basic Setup
	describe('Basic Setup Tests', () => {
		// Test Server Starting
		test('Server should start', async () => {
			const dss: DurableStreamTestServer = new DurableStreamTestServer({ port: 0 })
			const startPromise = dss.start()
			await expect(startPromise).resolves.toBeString()
			expect(dss.url).toBeString()

			await dss.stop()
		})

		// Take server starting, make a fixture, and do more tests based on that
		describe('Y.js Server should start on DSS', () => {
			let dss: DurableStreamTestServer
			let yjss: YjsServer
			beforeAll(async () => {
				dss = new DurableStreamTestServer({ port: 0 })
				const startPromise = dss.start()
				await expect(startPromise).resolves.toBeString()
				expect(dss.url).toBeString()

				yjss = new YjsServer({ port: 0, dsServerUrl: dss.url })
				await yjss.start()
			})

			// test y.js server starting
			test('Y.js server should start', async () => {
				expect(dss.url).toBeString()
				expect(yjss.url).toBeString()
				expect(yjss.getDsServerUrl()).toBeString()
			})

			describe('Y.js provider can connect to server', () => {
				let doc: Y.Doc
				let provider: YjsProvider
				let docId: string
				const textName = 'content'

				beforeEach(async () => {
					doc = new Y.Doc()
					docId = randomUUIDv7()
					provider = new YjsProvider({
						doc,
						baseUrl: `${yjss.url}/v1/yjs/test`,
						docId,
						connect: false,
						liveMode: 'long-poll',
					})
					await provider.connect()
					await waitForSync(provider)
				})

				test('Provider should sync', async () => {
					await expect(waitForSync(provider)).resolves.toBeUndefined()
				})

				test('Multiple Providers docs should sync', async () => {
					const doc2 = new Y.Doc()
					doc2.getText(textName)
					const provider2 = new YjsProvider({
						doc: doc2,
						baseUrl: `${yjss.url}/v1/yjs/test`,
						docId,
						connect: false,
						liveMode: 'long-poll',
					})

					await expect(provider2.connect()).resolves.toBeUndefined()
					await expect(waitForSync(provider2)).resolves.toBeUndefined()

					provider.doc.getText(textName).insert(0, 'abc')
					await provider.flush()
					await waitForSync(provider2)

					expect(provider.doc.getText(textName).toJSON()).toEqual('abc')
					await expect(waitForDocText(provider2.doc, textName)).resolves.toBeUndefined()
					expect(provider2.doc.getText(textName).toJSON()).toEqual('abc')

					provider2.doc.getText(textName).insert(3, 'def')
					expect(provider2.doc.getText(textName).toJSON()).toEqual('abcdef')
					await provider2.flush()
					await waitForSync(provider)
					await expect(waitForDocText(provider.doc, textName)).resolves.toBeUndefined()
					expect(provider.doc.getText(textName).toJSON()).toEqual('abcdef')
					expect(provider.doc.getText(textName).toJSON()).toEqual(provider2.doc.getText(textName).toJSON())
				})
			})
		})
	})
})
