// Context-budget fitting for one model call.
//
// `maxInputChars` is a budget for the WHOLE request — system template, continuity
// history, and the current user input — not a per-argument cap. The template is
// the task contract and is never cut; history is the cheapest thing to drop
// (it is continuity sugar, not the task), and the current input is cut only
// after history has been given up.
//
// Allocation order (deterministic, so the same config always produces the same
// prompt):
//   1. template            — kept whole
//   2. history             — up to `historyShare` of the remaining budget
//   3. current input       — the rest, truncated with a marker when needed
//
// Everything is measured in characters, matching the config field's unit.

import { buildHistoryBlock } from './prompts.js'

export const DEFAULT_HISTORY_SHARE = 0.35
export const MIN_INPUT_CHARS = 1200

/** Marker appended to a truncated current input. */
const INPUT_TAIL = '\n\n...（输入超出上下文预算，已截断）...'

function clampInt(value, min, max) {
  const num = Math.floor(Number(value))
  if (!Number.isFinite(num)) return min
  return Math.min(max, Math.max(min, num))
}

/**
 * Fit one prompt into the configured character budget.
 *
 * @param {{
 *   template: string,
 *   input: string,
 *   entries?: Array<{ type: string, at: string, text: string }>,
 *   rounds?: number,
 *   budget: number,
 *   historyShare?: number,
 *   minInputChars?: number,
 * }} request
 * @returns {{
 *   system: string,
 *   user: string,
 *   stats: {
 *     budget: number,
 *     templateChars: number,
 *     historyChars: number,
 *     inputChars: number,
 *     totalChars: number,
 *     historyEntries: number,
 *     droppedEntries: number,
 *     inputTruncated: boolean,
 *     historyTruncated: boolean,
 *     overBudget: boolean,
 *   },
 * }}
 */
export function fitPrompt(request) {
  const template = String(request.template ?? '')
  const input = String(request.input ?? '')
  const entries = Array.isArray(request.entries) ? request.entries : []
  const budget = clampInt(request.budget, 200, 1000000)
  const historyShare = Number.isFinite(request.historyShare)
    ? Math.min(1, Math.max(0, Number(request.historyShare)))
    : DEFAULT_HISTORY_SHARE
  const minInputChars = clampInt(request.minInputChars ?? MIN_INPUT_CHARS, 200, budget)

  const templateChars = template.length
  const available = Math.max(0, budget - templateChars)

  // The template alone already exceeds the budget: keep it (it is the contract)
  // and give the input a floor so the call is still meaningful. Reported as
  // overBudget instead of silently dropping the request.
  const overBudget = templateChars >= budget
  const effectiveAvailable = overBudget ? minInputChars : available

  // 1. History first: it is the cheapest thing to lose.
  const historyAllowance = Math.floor(effectiveAvailable * historyShare)
  let historyBlock = ''
  let historyEntries = 0
  let droppedEntries = 0
  let historyTruncated = false

  if (historyAllowance > 0 && entries.length > 0) {
    historyBlock = buildHistoryBlock(entries, request.rounds, historyAllowance)
    if (historyBlock) {
      // Recount what actually made it in (buildHistoryBlock reports the same
      // heading per kept entry, so count occurrences of the per-entry header).
      historyEntries = (historyBlock.match(/^### 第 /gm) || []).length
      droppedEntries = Math.max(0, Math.min(entries.length, Number(request.rounds) || entries.length) - historyEntries)
      historyTruncated = droppedEntries > 0 || historyBlock.includes('…（历史内容已截断）')
    } else {
      droppedEntries = entries.length
    }
  } else if (entries.length > 0) {
    droppedEntries = entries.length
  }

  // 2. Current input gets what is left, with a floor.
  const inputAllowance = Math.max(minInputChars, effectiveAvailable - historyBlock.length)
  let user = input
  let inputTruncated = false
  if (user.length > inputAllowance) {
    const keep = Math.max(0, inputAllowance - INPUT_TAIL.length)
    user = user.slice(0, keep) + INPUT_TAIL
    inputTruncated = true
  }

  const system = template + historyBlock
  const totalChars = system.length + user.length

  return {
    system,
    user,
    stats: {
      budget,
      templateChars,
      historyChars: historyBlock.length,
      inputChars: user.length,
      totalChars,
      historyEntries,
      droppedEntries,
      inputTruncated,
      historyTruncated,
      overBudget,
    },
  }
}

/**
 * One-line human-readable budget report, used by the status tool and by results
 * that had to cut something.
 * @param {ReturnType<typeof fitPrompt>['stats']} stats
 * @returns {string}
 */
export function describeBudget(stats) {
  const parts = [
    `模板 ${stats.templateChars}`,
    `历史 ${stats.historyChars}`,
    `输入 ${stats.inputChars}`,
    `合计 ${stats.totalChars}/${stats.budget} 字符`,
  ]
  if (stats.droppedEntries > 0) parts.push(`丢弃历史 ${stats.droppedEntries} 条`)
  if (stats.historyTruncated && stats.droppedEntries === 0) parts.push('历史已截断')
  if (stats.inputTruncated) parts.push('输入已截断')
  if (stats.overBudget) parts.push('模板已超预算')
  return parts.join(' · ')
}
