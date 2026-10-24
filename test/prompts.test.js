// Prompt-asset invariants.
//
// The templates are the product's behaviour, so they are treated as fixtures:
// every asset must carry the reliability constraints that keep the model from
// inventing business rules, and every asset must keep the format contract its
// consumer relies on (H1–H6 hierarchy, table columns, YAML sections, strict JSON).

import test from 'node:test'
import assert from 'node:assert/strict'

import { loadPrompt, templateFiles, testcaseTemplateKey } from '../lib/prompts.js'

const ALL = Object.keys(templateFiles())

test('all seven prompt assets load', () => {
  for (const key of ALL) {
    const text = loadPrompt(key)
    assert.ok(text.length > 800, `${key} is unexpectedly short (${text.length} chars)`)
    assert.ok(text.length < 20000, `${key} is unexpectedly long (${text.length} chars)`)
  }
})

test('every asset carries the MIT attribution and reliability constraints', () => {
  for (const key of ALL) {
    const text = loadPrompt(key)
    assert.match(text, /AITestCase/, `${key} must keep the upstream attribution`)
    assert.match(text, /可靠性约束/, `${key} must keep the reliability header`)
  }
})

test('the constraints forbid inventing undefined rules', () => {
  for (const key of ALL) {
    const text = loadPrompt(key)
    assert.match(text, /不得(用|兑|替)|不要替|不得杜撰/, `${key} must forbid fabrication in some form`)
  }
})

test('generation assets keep their tagged-input protocol', () => {
  assert.match(loadPrompt('testprd'), /\[主PRD\]/)
  assert.match(loadPrompt('testpoint'), /\[优化后PRD\]/)
  for (const key of ['testcase_xmind', 'testcase_table', 'testcase_yaml']) {
    const text = loadPrompt(key)
    assert.match(text, /\[优化后PRD\]/, `${key} must accept the PRD tag`)
    assert.match(text, /\[测试点\]/, `${key} must accept the test-point constraint tag`)
    assert.match(text, /\[补充说明\]/, `${key} must accept the instruction tag`)
  }
})

test('format contracts survive the reliability revision', () => {
  assert.match(loadPrompt('testcase_xmind'), /H1[~–-]?H6/, 'xmind output must stay an H1–H6 hierarchy')
  assert.match(loadPrompt('testcase_table'), /\|\s*ID\s*\|/, 'table output must keep its ID column')
  assert.match(loadPrompt('testcase_table'), /\|\s*操作步骤\s*\|/, 'table output must keep the step column')
  const yaml = loadPrompt('testcase_yaml')
  assert.match(yaml, /metadata:/)
  assert.match(yaml, /scenarios:/)
})

test('evaluation assets demand machine-parseable JSON', () => {
  const evaluator = loadPrompt('evaluator')
  assert.match(evaluator, /JSON\.parse/, 'evaluator must demand parseable JSON')
  assert.match(evaluator, /不要 Markdown 代码块标记/)
  assert.match(loadPrompt('critic'), /"score"/)
})

test('review assets state that the verdict needs a human', () => {
  for (const key of ['evaluator', 'critic']) {
    assert.match(loadPrompt(key), /辅助建议|人工复核|测试工程师复核/, `${key} must not claim a final verdict`)
  }
})

test('the test-case template selector maps every format', () => {
  assert.equal(testcaseTemplateKey('xmind'), 'testcase_xmind')
  assert.equal(testcaseTemplateKey('table'), 'testcase_table')
  assert.equal(testcaseTemplateKey('yaml'), 'testcase_yaml')
  assert.equal(testcaseTemplateKey(undefined), 'testcase_xmind')
  assert.equal(testcaseTemplateKey('unknown'), 'testcase_xmind')
})
