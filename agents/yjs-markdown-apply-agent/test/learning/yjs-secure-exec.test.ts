import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { withCodeMode } from './proxy'
import { NodeExecutionDriver, type BindingTree } from 'secure-exec'

describe('Secure-exec <> Y.js Learning tests', async () => {
    test('Y.XMLFragment can be built normally', async () => {
        const yDoc = new Y.Doc()
        const yXmlFragment = yDoc.getXmlFragment('test-fragment')

        const yXmlElement = new Y.XmlElement('example-node')
        yXmlFragment.insert(0, [yXmlElement])

        expect(yXmlFragment.toJSON()).toEqual('<example-node></example-node>')
    })

    test('Structured Clone-ability', async () => {
        const yDoc = new Y.Doc()
        const yXmlFragment = yDoc.getXmlFragment('test-fragment')

        const yXmlElement = new Y.XmlElement('example-node')
        yXmlFragment.insert(0, [yXmlElement])

        expect(yXmlFragment.toJSON()).toEqual('<example-node></example-node>')
        expect(yXmlFragment.get(0)).toEqual(yXmlElement)
        expect(yXmlFragment.get(1)).toBeUndefined()

        expect(() => structuredClone(yXmlFragment)).toThrowError()
        expect(() => structuredClone(yXmlElement)).toThrowError()
    })

    test('Secure-Exec Driver exposes basic custom bindings', async () => {
        const yDoc = new Y.Doc()
        const yXmlFragment = yDoc.getXmlFragment()
        const bindings: BindingTree = {
            add: (a, b) => (a as number) + (b as number),
        }

        await withCodeMode(yXmlFragment, bindings, async (driver: NodeExecutionDriver) => {
            const result = await driver.run(`module.exports = {a: SecureExec.bindings.add(1,1)}`)
            expect(result.exports).toHaveProperty('a')
            expect((result.exports as { a: number }).a).toEqual(2)
        })
    })

    test('fragment bindings can push nested content into the live fragment', async () => {
        const yDoc = new Y.Doc()
        const yXmlFragment = yDoc.getXmlFragment()

        await withCodeMode(yXmlFragment, {}, async (driver) => {
            const result = await driver.run(`
                const { fragment } = SecureExec.bindings
                const refs = fragment.push([
                    {
                        kind: 'element',
                        nodeName: 'section',
                        attributes: { id: 'intro' },
                        children: [
                            {
                                kind: 'element',
                                nodeName: 'paragraph',
                                children: [{ kind: 'text', text: 'Hello' }],
                            },
                        ],
                    },
                ])

                module.exports = {
                    refs,
                    length: fragment.length(),
                    xml: fragment.toJSON(),
                }
            `)

            expect(result.code).toBe(0)
            expect(result.exports).toEqual({
                refs: [{ id: 'xml_1', kind: 'element' }],
                length: 1,
                xml: '<section id="intro"><paragraph>Hello</paragraph></section>',
            })
        })

        expect(yXmlFragment.toJSON()).toBe('<section id="intro"><paragraph>Hello</paragraph></section>')
    })

    test('element bindings can mutate multiple levels deep', async () => {
        const yDoc = new Y.Doc()
        const yXmlFragment = yDoc.getXmlFragment()
        const section = new Y.XmlElement('section')
        const paragraph = new Y.XmlElement('paragraph')
        const text = new Y.XmlText()
        text.insert(0, 'Hello')
        paragraph.push([text])
        section.push([paragraph])
        yXmlFragment.push([section])

        await withCodeMode(yXmlFragment, {}, async (driver) => {
            const result = await driver.run(`
                const { fragment, element, text } = SecureExec.bindings

                const section = fragment.get(0)
                const paragraph = element.get(section, 0)
                const paragraphText = element.get(paragraph, 0)

                text.insert(paragraphText, 5, ' world')
                element.setAttribute(section, 'status', 'updated')

                module.exports = {
                    sectionName: element.nodeName(section),
                    text: text.toString(paragraphText),
                    xml: fragment.toJSON(),
                }
            `)

            expect(result.code).toBe(0)
            expect(result.exports).toEqual({
                sectionName: 'section',
                text: 'Hello world',
                xml: '<section status="updated"><paragraph>Hello world</paragraph></section>',
            })
        })

        expect(yXmlFragment.toJSON()).toBe('<section status="updated"><paragraph>Hello world</paragraph></section>')
    })

    test('insertAfter works with refs returned from get at nested levels', async () => {
        const yDoc = new Y.Doc()
        const yXmlFragment = yDoc.getXmlFragment()
        const section = new Y.XmlElement('section')
        section.push([new Y.XmlElement('first')])
        yXmlFragment.push([section])

        await withCodeMode(yXmlFragment, {}, async (driver) => {
            const result = await driver.run(`
                const { fragment, element } = SecureExec.bindings

                const section = fragment.get(0)
                const first = element.get(section, 0)
                const inserted = element.insertAfter(section, first, [
                    { kind: 'element', nodeName: 'second', children: [{ kind: 'text', text: 'two' }] },
                ])

                module.exports = {
                    inserted,
                    xml: fragment.toJSON(),
                }
            `)

            expect(result.code).toBe(0)
            expect(result.exports).toEqual({
                inserted: [{ id: 'xml_3', kind: 'element' }],
                xml: '<section><first></first><second>two</second></section>',
            })
        })

        expect(yXmlFragment.toJSON()).toBe('<section><first></first><second>two</second></section>')
    })
})
