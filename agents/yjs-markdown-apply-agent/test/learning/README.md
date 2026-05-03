# QuickJS Y.Xml Proxy Learning Harness

This directory is for learning the thinnest possible bridge between generated code and a live `Y.XmlFragment`.

The current direction is direct mutation through host bindings:

1. The edit tool receives `path`, `oldString`, and `newString`.
2. The host deterministically resolves `path` to the target `Y.XmlFragment`.
3. Generated code runs in an isolated JS runtime.
4. Bindings proxy operations onto the already-selected fragment.
5. Binding calls mutate the live Yjs fragment; returned strings/objects are diagnostics only.

## Harness

Use `withQuickJsMode` or `withAsyncQuickJsMode` from `@humanlayer/quickjs-exec` to avoid repeating QuickJS setup/teardown. The helpers are intentionally unopinionated; pass Yjs-specific behavior as bindings from the learning test:

```ts
const doc = new Y.Doc()
const fragment = doc.getXmlFragment('learning')
fragment.push([yParagraph('Hello')])

await withQuickJsMode(
  {
    add: (a, b) => Number(a) + Number(b),
    fragmentToJSON: () => fragment.toJSON(),
  },
  ({ run }) => {
    const result = run(`
      ({
        sum: bindings.add(20, 22),
        xml: bindings.fragmentToJSON(),
      })
    `)

    expect(fragment.toJSON()).toBe('<paragraph>Hello</paragraph>')
  },
)
```

`bindings` registers host functions. In QuickJS code, call them through the injected `bindings` facade:

```js
bindings.bindingName(arg1, arg2)
```

The facade JSON-serializes host results under the hood so the test code can stay close to the eventual Secure Exec code. `withAsyncQuickJsMode` has the same shape but uses QuickJS asyncified host functions, so bindings may be `async`.

## Incremental Binding Plan

Build one capability per test, in this order:

1. Read-only fragment diagnostics: `fragment.toJSON`, `fragment.length`.
2. Top-level insertion: `fragment.push` with simple element specs.
3. Recursive content specs: nested element/text creation.
4. Refs: `fragment.get` returns a structured-cloneable `XmlRef`.
5. Element read methods: `element.nodeName`, `element.length`, `element.get`.
6. Deep traversal: repeated `element.get` over multiple levels.
7. Text read/write: `text.toString`, `text.insert`, `text.delete`.
8. `insertAfter` with refs returned by `get`.
9. Element attributes: `getAttributes`, `setAttribute`, `removeAttribute`.
10. Error behavior: invalid ref/kind/index errors come back to the generated-code caller.

Keep the bridge thin. Do not add validation, schema checks, snapshot/commit flow, or replacement-string semantics while these learning tests are being built.
