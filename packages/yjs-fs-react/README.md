# @humanlayer/yjs-fs-react

React bindings for [`@humanlayer/yjs-fs`](../yjs-fs). Provides a context provider for a `YjsFilesystem` session plus hooks that subscribe to filesystem and awareness changes and re-render automatically, so components stay in sync with the underlying Yjs CRDT without manual event wiring.

## Install

```sh
bun add @humanlayer/yjs-fs-react @humanlayer/yjs-fs yjs y-protocols react
```

## Usage

Wrap your app in a provider, then read/write with hooks. Use `YjsFilesystemProvider` when your app already created the `YjsFilesystem`, `Awareness`, and transport provider:

```tsx
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { YjsFilesystemProvider, useFilesystem, useFilesystemTree } from '@humanlayer/yjs-fs-react'
import * as Y from 'yjs'

const doc = new Y.Doc()
const filesystem = new YjsFilesystem({ doc })

function App() {
  return (
    <YjsFilesystemProvider filesystem={filesystem}>
      <FileTree />
    </YjsFilesystemProvider>
  )
}

function FileTree() {
  const filesystem = useFilesystem()
  const tree = useFilesystemTree('/')

  return (
    <button onClick={() => filesystem.createFile('/notes.md', '# hi')}>
      {tree.children.length} entries
    </button>
  )
}
```

Use `YjsFilesystemSessionProvider` when session creation is async (e.g. connecting a transport provider before the tree is usable). It calls `createSession`, renders `loading` until it resolves, and calls `session.destroy()` on unmount:

```tsx
<YjsFilesystemSessionProvider
  createSession={async () => {
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    const provider = new SomeYjsProvider({ doc, awareness })
    await provider.connect()
    return { filesystem: new YjsFilesystem({ doc, awareness }), awareness, provider, destroy: () => provider.destroy() }
  }}
  loading={<div>Loading…</div>}
>
  <App />
</YjsFilesystemSessionProvider>
```

## Hooks

- `useFilesystem()` / `useYjsFilesystem()` — the raw `YjsFilesystem` instance for imperative calls (`createFile`, `mkdir`, `rename`, `unlink`, `stat`, ...).
- `useFilesystemSession()` / `useYjsFilesystemSession()` — the full context: `{ filesystem, awareness, provider }`.
- `useDirectoryEntries(path?)` — `EntryDirent[]` of immediate children, re-renders on any filesystem change.
- `useFilesystemTree(path?)` / `useTree()` — recursive `FilesystemTreeNode` rooted at `path` (defaults to `/`).
- `useEntryStat(path)` / `useStat()` — `EntryStat | null` for a path, subscribed to just that path.
- `useYTextForFile(path)` / `useYText()` — the collaborative `Y.Text` backing a text file, for binding to editors like TipTap or Monaco.
- `useFileSelector(path, select)` / `useSnapshot()` — escape hatch to derive an arbitrary value from the filesystem, re-evaluated whenever `path` changes.
- `useYjsProvider()` / `useProvider()` — the raw transport provider instance.
- `useConnectionStatus()` — `'disconnected' | 'connecting' | 'connected'`, read from the provider's `connected`/`connecting` flags and `'status'` events.
- `useIsSynced()` / `useSynced()` — whether the provider has completed initial sync (`'synced'` event).
- `useYjsAwareness()` / `useAwareness()` — the `Awareness` instance (throws if none was provided).
- `useAwarenessStates()` — reactive `Map<clientId, TState>` of all peers' awareness state, for presence UIs.
- `useFilesystemRawYDoc()` / `useYjsDocument()` / `useDoc()` — the underlying `Y.Doc`.

All change-driven hooks subscribe to `filesystem.subscribe` / `filesystem.subscribePath` (or awareness's `'change'` event and the provider's `'status'`/`'synced'` events) and re-render on change, so updates from remote peers propagate automatically without manual listeners.

Connection-status hooks work with any transport provider shaped like `{ connected?, connecting?, synced?, on(event, fn), off(event, fn) }` — this matches y-websocket, y-webrtc, and similar providers without requiring a specific one.
