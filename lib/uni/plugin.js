// dsh-uni-remote — uni extension layer entry (cordis sub-plugin).
//
// Mounted as the second bundle-patch entry (`id: dsh-uni-sync`,
// `name: dsh-uni-remote/uni-sync`). Deliberately independent of the upstream
// dsh-remote entry so the base stays a clean fork and uni features evolve
// without touching forked lib code.
//
// v0.1 scaffold: proves the two-entry bundle pattern, exports the P4 push
// engine. M6 mounts real RPC + the settings-page button.

import { collectLocalProfile } from './sync.js'

export const name = 'dsh-uni-sync'

export function apply(ctx) {
  const log = ctx.logger?.info?.bind(ctx.logger) ?? console.info
  log('[dsh-uni-sync] extension layer loaded (P4 push engine scaffold, v0.1)')
}

export { collectLocalProfile }
