// dsh-aitestcase — runtime entry.
//
// The loader row resolves this file. It exports:
//   - `name`   plugin name
//   - `inject` host services that must be ready before `apply` runs
//   - `Config` schemastery schema: Cordis validates the row config with it, and
//     the harness derives the Plugins-page live Config form from it
//   - `apply`  registers the six test-design tools
//
// The browser half lives in ./client.js and is declared in package.json under
// `dsh.client` + `exports["./client"]`.
//
// HMR note: a host-module reload is what makes edits here take effect; a plain
// loader remount keeps the cached ES module instance.

import { Config } from './config.js'
import { resolveOptions } from './options.js'
import { registerTools } from './tools.js'

export { Config }

export const name = 'dsh-aitestcase'

// `tools` provides the registry; `llm` is the model route used for one-shot
// generation calls.
export const inject = ['tools', 'llm']

/**
 * Mount the plugin.
 * @param {object} ctx Cordis context
 * @param {object|undefined} config resolved row config
 */
export function apply(ctx, config) {
  // Resolved per call (not once here) so a live Config-form edit takes effect on
  // the next tool call without remounting the plugin.
  registerTools(ctx, () => resolveOptions(config))
}
