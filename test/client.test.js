// Client-half smoke tests.
//
// The browser half cannot run in Node (it expects the page's module loader and
// react), so this harness evaluates the real lib/client.js inside a VM with a
// minimal sandbox: the loader captures the factory, `require('react')` returns a
// createElement stub, and the render pass walks the returned tree. That catches
// syntax errors, a wrong module id, a wrong slot registration, and a component
// that throws on first render — the failures that would otherwise only show up
// as a broken page. Clipboard tests also exercise the real click handlers and
// re-render their state; this is not a browser or host integration test.

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const CLIENT_URL = new URL('../lib/client.js', import.meta.url)

function createHarness({ navigator = {}, document = {} } = {}) {
  const source = readFileSync(CLIENT_URL, 'utf8')
  let loaded = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(options) {
          loaded = options
        },
      },
    },
    navigator,
    document: {
      createElement() {
        return { style: {}, select() {}, value: '' }
      },
      body: { appendChild() {}, removeChild() {} },
      execCommand() {
        return true
      },
      ...document,
    },
    setTimeout: () => 0,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

  const states = []
  let hookIndex = 0
  const react = {
    createElement(type, props, ...children) {
      return { type, props: { ...props, children }, children }
    },
    useState(initial) {
      const index = hookIndex++
      if (!(index in states)) states[index] = initial
      return [states[index], (next) => { states[index] = next }]
    },
  }
  const require = (id) => {
    if (id === 'react') return react
    throw new Error(`unexpected client require: ${id}`)
  }
  const exported = loaded.factory(require)
  let section
  exported.apply({
    slots: {
      inject: (_key, callback) => callback(),
      register: (_options, component) => { section = component; return () => {} },
    },
  })
  return {
    loaded,
    exported,
    renderSection() {
      hookIndex = 0
      return section()
    },
  }
}

function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (typeof node === 'object' && node.children) {
    if (typeof node.type === 'function') return flatten(node.type(node.props), out)
    for (const child of node.children) flatten(child, out)
  }
  return out
}

test('client bundle registers itself under the package id', () => {
  const { loaded, exported } = createHarness()
  assert.equal(loaded.id, 'dsh-aitestcase')
  assert.equal(typeof loaded.factory, 'function')
  assert.equal(exported.name, 'aitestcase')
  // Spread into a host-realm array: the VM returns arrays from its own realm.
  assert.deepEqual([...exported.inject], ['slots'])
  assert.equal(typeof exported.apply, 'function')
})

test('apply registers one settings page under the expected slot contract', () => {
  const { exported } = createHarness()
  const registrations = []
  const injections = []
  const ctx = {
    slots: {
      inject(key, callback) {
        injections.push(key)
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  exported.apply(ctx)

  assert.deepEqual(injections, ['settings.section'])
  assert.equal(registrations.length, 1)
  const { options, component } = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'aitestcase')
  assert.equal(typeof options.order, 'number')
  assert.equal(options.label(), '测试设计')
  assert.equal(typeof component, 'function')
})

test('the settings page renders readable content with every capability', () => {
  const { exported } = createHarness()
  let component = null
  exported.apply({
    slots: {
      inject: (_key, callback) => callback(),
      register: (_options, registered) => {
        component = registered
        return () => {}
      },
    },
  })

  const tree = component()
  const text = flatten(tree).join(' | ')

  assert.match(text, /测试设计/)
  assert.match(text, /本地编排/)
  assert.match(text, /不代表本地推理/)
  assert.match(text, /AI 辅助评审/)
  assert.match(text, /说明页已打开 v\d+\.\d+\.\d+/)
  assert.match(text, /请运行 aitestcase_status 自检/)
  assert.doesNotMatch(text, /● 已加载|无外部依赖/)
  for (const tool of [
    'aitestcase_testprd',
    'aitestcase_testpoints',
    'aitestcase_testcases',
    'aitestcase_evaluate',
    'aitestcase_history',
    'aitestcase_status',
  ]) {
    assert.ok(text.includes(tool), `page must document ${tool}`)
  }
  assert.match(text, /outputDir/)
  assert.match(text, /\.aitestcase/)
  assert.match(text, /复制/)
})

test('the page survives a render with no clipboard support', () => {
  const { exported } = createHarness()
  let component = null
  exported.apply({
    slots: {
      inject: (_key, callback) => callback(),
      register: (_options, registered) => {
        component = registered
        return () => {}
      },
    },
  })
  assert.doesNotThrow(() => component())
})

function buttons(node, found = []) {
  if (!node || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) buttons(child, found)
    return found
  }
  if (node.type === 'button') found.push(node)
  for (const child of node.children || []) buttons(child, found)
  return found
}

test('clipboard success displays copied only after the write resolves', async () => {
  let finishWrite
  const harness = createHarness({
    navigator: { clipboard: { writeText: () => new Promise((resolve) => { finishWrite = resolve }) } },
  })
  buttons(harness.renderSection())[0].props.onClick()
  assert.doesNotMatch(flatten(harness.renderSection()).join(' '), /已复制/)
  finishWrite()
  await Promise.resolve()
  assert.match(flatten(harness.renderSection()).join(' '), /已复制/)
})

test('clipboard rejection falls back and reports a failed copy without exposing the error', async () => {
  let fallbackAttempts = 0
  let removed = 0
  const harness = createHarness({
    navigator: { clipboard: { writeText: () => Promise.reject(new Error('private permission details')) } },
    document: {
      execCommand: () => { fallbackAttempts++; return false },
      body: { appendChild() {}, removeChild() { removed++ } },
    },
  })
  buttons(harness.renderSection())[0].props.onClick()
  await Promise.resolve()
  const text = flatten(harness.renderSection()).join(' ')
  assert.equal(fallbackAttempts, 1)
  assert.equal(removed, 1)
  assert.match(text, /复制失败，请手动选择文本/)
  assert.doesNotMatch(text, /已复制|private permission details/)
})

test('clipboard rejection may use a successful legacy copy fallback', async () => {
  const harness = createHarness({
    navigator: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } },
  })
  buttons(harness.renderSection())[0].props.onClick()
  await Promise.resolve()
  const text = flatten(harness.renderSection()).join(' ')
  assert.match(text, /已复制/)
  assert.doesNotMatch(text, /复制失败/)
})

test('missing clipboard API reports legacy copy errors and cleans up its temporary element', () => {
  let removed = 0
  const harness = createHarness({
    document: {
      execCommand: () => { throw new Error('unsupported') },
      body: { appendChild() {}, removeChild() { removed++ } },
    },
  })
  buttons(harness.renderSection())[0].props.onClick()
  assert.equal(removed, 1)
  assert.match(flatten(harness.renderSection()).join(' '), /复制失败，请手动选择文本/)
})
