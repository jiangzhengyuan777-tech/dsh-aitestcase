// Version consistency: the release version appears in package.json and in the
// browser half (which cannot read package.json through the lazy-CJS factory), so
// a test keeps the two from drifting. Docs are checked too, because a stale test
// count or version in README/USAGE is a lie users act on.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { PLUGIN_VERSION } from '../lib/version.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const usage = readFileSync(new URL('../USAGE.md', import.meta.url), 'utf8')
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('the runtime constant, the browser half, and package.json agree', () => {
  assert.equal(PLUGIN_VERSION, pkg.version)
  const match = client.match(/var VERSION = '([^']+)'/)
  assert.ok(match, 'client.js must declare VERSION')
  assert.equal(match[1], pkg.version)
})

test('the package is publishable and declares both halves', () => {
  assert.equal(pkg.private, undefined, 'the package must stay publishable')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings'])
})

test('the patch layer restates the same version of config keys as the schema', () => {
  // A key present in config.js but missing here (or vice versa) breaks the
  // bundle layer or the Config form; config.test.js checks the schema side.
  for (const key of [
    'provider',
    'model',
    'temperature',
    'maxTokens',
    'outputDir',
    'saveArtifacts',
    'historyRounds',
    'maxInputChars',
    'historyShare',
    'maxRetries',
    'retryBaseMs',
    'jsonRepair',
  ]) {
    assert.match(patch, new RegExp(`^\\s+${key}:`, 'm'), `cordis.patch.yml must restate ${key}`)
  }
})

test('docs do not advertise a stale test count or version', () => {
  for (const [name, text] of [
    ['README.md', readme],
    ['USAGE.md', usage],
  ]) {
    const counts = [...text.matchAll(/(\d+)\s*(?:个单元测试|\/\s*\d+\s*通过)/g)].map((match) => Number(match[1]))
    for (const count of counts) {
      assert.ok(count >= 47, `${name} mentions only ${count} tests; update it to the real suite size`)
    }
    assert.doesNotMatch(text, /\b1\.0\.[01]\b/, `${name} still mentions a 1.0.x version`)
  }
})
