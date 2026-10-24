// Config-schema tests.
//
// The schemastery schema is what Cordis uses to validate the loader row and what
// the harness turns into the Plugins-page live Config form. These tests run
// against a real schemastery instance (linked from the DSH runtime for local
// verification), so a schema mistake fails here instead of at plugin load.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_OPTIONS, resolveOptions } from '../lib/options.js'
import { registerTools } from '../lib/tools.js'

// schemastery is a host-provided peer: present in a DSH runtime (or when a local
// link exists), absent in a bare checkout. Skip instead of failing there.
let schemasteryReady = true
try {
  import.meta.resolve('@deepseek-ai/schemastery')
} catch (error) {
  // Only an absent direct host peer is optional. Broken source code, an invalid
  // package export, or a missing transitive dependency must fail the test run.
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !/^Cannot find package '@deepseek-ai\/schemastery' imported from /.test(error.message)) {
    throw error
  }
  schemasteryReady = false
}
const Config = schemasteryReady ? (await import('../lib/config.js')).Config : undefined
const testWithHost = schemasteryReady ? test : test.skip

const PATCH_URL = new URL('../cordis.patch.yml', import.meta.url)

testWithHost('Config is a schemastery object exposing exactly the documented fields', () => {
  assert.equal(typeof Config, 'function', 'Config must be a schemastery schema')
  const dict = Config.dict
  assert.ok(dict, 'z.object() must expose a field dictionary')
  const keys = Object.keys(dict).sort()
  assert.deepEqual(keys, [
    'historyRounds',
    'historyShare',
    'jsonRepair',
    'maxInputChars',
    'maxRetries',
    'maxTokens',
    'model',
    'outputDir',
    'provider',
    'retryBaseMs',
    'saveArtifacts',
    'temperature',
  ])
  for (const key of keys) {
    assert.equal(dict[key].meta.volatile, true, `${key} must be volatile so the Config form serves it`)
    assert.equal(typeof dict[key].meta.description, 'string', `${key} needs a description for the form`)
    assert.ok(dict[key].meta.description.length > 6, `${key} description must be readable`)
  }
})

testWithHost('Config fills defaults and rejects out-of-range values', () => {
  // Volatile fields come back as references; the tool path always unwraps them.
  const resolved = resolveOptions(Config({}))
  assert.deepEqual(resolved, DEFAULT_OPTIONS)

  assert.throws(() => Config({ temperature: 99 }), /temperature/)
  assert.throws(() => Config({ historyRounds: 99 }), /historyRounds/)
  assert.throws(() => Config({ maxInputChars: 10 }), /maxInputChars/)
  assert.throws(() => Config({ maxTokens: 255 }), /maxTokens/)
})

testWithHost('Config accepts integer token and context budgets at both boundaries', () => {
  for (const maxTokens of [256, 257, 4096, 65535, 65536]) {
    assert.equal(resolveOptions(Config({ maxTokens })).maxTokens, maxTokens)
  }
  for (const maxTokens of [255, 65537, 256.5]) {
    assert.throws(() => Config({ maxTokens }), /maxTokens/)
  }
  for (const maxInputChars of [1000, 1001, 199999, 200000]) {
    assert.equal(resolveOptions(Config({ maxInputChars })).maxInputChars, maxInputChars)
  }
  for (const maxInputChars of [999, 200001, 1000.5]) {
    assert.throws(() => Config({ maxInputChars }), /maxInputChars/)
  }
})

test('option resolution clamps token and context budgets consistently without host schemas', () => {
  assert.equal(resolveOptions({ maxTokens: 255 }).maxTokens, 256)
  assert.equal(resolveOptions({ maxTokens: 65537 }).maxTokens, 65536)
  assert.equal(resolveOptions({ maxTokens: 4096 }).maxTokens, 4096)
  assert.equal(resolveOptions({ maxInputChars: 999 }).maxInputChars, 1000)
  assert.equal(resolveOptions({ maxInputChars: 200001 }).maxInputChars, 200000)
  assert.equal(resolveOptions({ maxInputChars: 1001 }).maxInputChars, 1001)
})

testWithHost('every key in the bundle patch is a known Config field', () => {
  const patch = readFileSync(PATCH_URL, 'utf8')
  const configBlock = patch.split(/^\s*config:\s*$/m)[1] || ''
  const keys = [...configBlock.matchAll(/^\s{8}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1])
  assert.ok(keys.length >= 8, `expected the patch to restate every config key, saw ${keys.join(', ')}`)
  const known = new Set(Object.keys(Config.dict))
  for (const key of keys) assert.ok(known.has(key), `patch key ${key} is not in the Config schema`)
})

testWithHost('the resolved config is what the tools actually consume', async () => {
  const registered = new Map()
  const ctx = {
    tools: { register: (definition) => registered.set(definition.name, definition) },
    llm: {
      stream: () =>
        (async function* stream() {
          yield { type: 'text-delta', index: 0, text: '结果' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
    },
  }
  const config = Config({ model: 'from-schema', maxTokens: 4000, historyRounds: 0, saveArtifacts: false })
  registerTools(ctx, () => resolveOptions(config))
  assert.equal(registered.size, 6)

  const exec = { agent: { session: {} }, signal: new AbortController().signal }
  const result = await registered.get('aitestcase_testpoints').execute({ requirement: '需求' }, exec)
  assert.match(result.model, /from-schema/)
})
