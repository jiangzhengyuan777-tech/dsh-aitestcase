// Client-half smoke tests.
//
// The browser half cannot run in Node (it expects the page's module loader and
// react), so this harness evaluates the real lib/client.js inside a VM with a
// minimal sandbox: the loader captures the factory, `require('react')` returns a
// createElement stub, and the render pass walks the returned tree. That catches
// syntax errors, a wrong module id, a wrong slot registration, and a component
// that throws on first render — the failures that would otherwise only show up
// as a broken page.

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const CLIENT_URL = new URL('../lib/client.js', import.meta.url)

function createHarness() {
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
    navigator: {},
    document: {
      createElement() {
        return { style: {}, select() {}, value: '' }
      },
      body: { appendChild() {}, removeChild() {} },
      execCommand() {
        return true
      },
    },
    setTimeout: () => 0,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

  const react = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      return [initial, () => {}]
    },
  }
  const require = (id) => {
    if (id === 'react') return react
    throw new Error(`unexpected client require: ${id}`)
  }
  const exported = loaded.factory(require)
  return { loaded, exported }
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
  assert.match(text, /自包含/)
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
