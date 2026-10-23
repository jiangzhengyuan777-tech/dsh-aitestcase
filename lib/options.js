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
  maxInputChars: 60000,
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
  }
}

/** Defaults, exported for the status tool and tests. */
export function defaultOptions() {
  return { ...DEFAULT_OPTIONS }
}
