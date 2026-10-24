// Option resolution for one tool call.
//
// Deliberately free of any @deepseek-ai import so the pure tool logic stays
// testable with plain `node --test`. The schemastery schema that produces these
// values lives in ./config.js and is only loaded by the runtime entry.

export const DEFAULT_OPTIONS = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  temperature: 0,
  maxTokens: 20000,
  outputDir: '.aitestcase',
  saveArtifacts: true,
  historyRounds: 4,
  // Combined character budget for the system prompt, history, and current input.
  maxInputChars: 60000,
  // Share of the remaining budget the continuity history may use (0–1).
  historyShare: 0.35,
  // Transient-failure recovery for one model call (0 disables retrying).
  maxRetries: 2,
  retryBaseMs: 800,
  // Ask the model to repair its own evaluation output when it is not valid JSON.
  jsonRepair: true,
}

/** Read one option, unwrapping a volatile reference when the harness supplied one. */
function readOption(config, key) {
  const raw = config && typeof config === 'object' ? config[key] : undefined
  const value = raw && typeof raw.get === 'function' ? raw.get() : raw
  return value === undefined || value === null ? DEFAULT_OPTIONS[key] : value
}

function clampInt(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.floor(num)))
}

function clampFloat(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

/**
 * Resolve the effective options for one call. Called at execution time so a live
 * Config-form edit takes effect on the next tool call without a remount.
 * @param {object|undefined} config row config handed to `apply`
 * @returns {typeof DEFAULT_OPTIONS}
 */
export function resolveOptions(config) {
  const provider = String(readOption(config, 'provider') || '').trim() || DEFAULT_OPTIONS.provider
  const model = String(readOption(config, 'model') || '').trim() || DEFAULT_OPTIONS.model
  const outputDir = String(readOption(config, 'outputDir') || '').trim() || DEFAULT_OPTIONS.outputDir
  const temperatureRaw = Number(readOption(config, 'temperature'))
  const temperature = Number.isFinite(temperatureRaw)
    ? Math.min(2, Math.max(0, temperatureRaw))
    : DEFAULT_OPTIONS.temperature
  return {
    provider,
    model,
    temperature,
    maxTokens: clampInt(readOption(config, 'maxTokens'), 256, 65536, DEFAULT_OPTIONS.maxTokens),
    outputDir,
    saveArtifacts: Boolean(readOption(config, 'saveArtifacts')),
    historyRounds: clampInt(readOption(config, 'historyRounds'), 0, 10, DEFAULT_OPTIONS.historyRounds),
    maxInputChars: clampInt(readOption(config, 'maxInputChars'), 1000, 200000, DEFAULT_OPTIONS.maxInputChars),
    historyShare: clampFloat(readOption(config, 'historyShare'), 0, 1, DEFAULT_OPTIONS.historyShare),
    maxRetries: clampInt(readOption(config, 'maxRetries'), 0, 5, DEFAULT_OPTIONS.maxRetries),
    retryBaseMs: clampInt(readOption(config, 'retryBaseMs'), 200, 10000, DEFAULT_OPTIONS.retryBaseMs),
    jsonRepair: Boolean(readOption(config, 'jsonRepair')),
  }
}

/** Defaults, exported for the status tool and tests. */
export function defaultOptions() {
  return { ...DEFAULT_OPTIONS }
}
