// Per-Session generation memory.
//
// AITestCase keeps a server-side history per sessionId so a later "把第 3 条用例
// 改一下" can build on the previous answer. The plugin keeps the same continuity
// without writing durable Session messages: entries are bucketed by the opaque
// `exec.agent.session` object in a WeakMap, so they disappear with the Session.
//
// HMR note: a module reload resets this memory (the fiber is re-created). That
// is deliberate — generation history is convenience state, never a source of
// truth — and the artifact files on disk remain the durable copy.

const bySession = new WeakMap()
const fallback = []

function bucketOf(exec) {
  const session = exec && exec.agent ? exec.agent.session : undefined
  if (session && (typeof session === 'object' || typeof session === 'function')) {
    let list = bySession.get(session)
    if (!list) {
      list = []
      bySession.set(session, list)
    }
    return list
  }
  return fallback
}

/**
 * Append one generation record to its Session bucket.
 * @param {object|undefined} exec tool run context
 * @param {{ type: string, format?: string, text: string, at: string }} entry
 */
export function recordGeneration(exec, entry) {
  const bucket = bucketOf(exec)
  bucket.push({
    type: String(entry.type ?? 'unknown'),
    format: entry.format ? String(entry.format) : '',
    text: String(entry.text ?? ''),
    at: String(entry.at ?? new Date().toISOString()),
  })
  // Keep the bucket bounded; history is continuity context, not an archive.
  if (bucket.length > 32) bucket.splice(0, bucket.length - 32)
}

/**
 * Read the previous generations of this Session.
 * @param {object|undefined} exec
 * @returns {Array<{ type: string, format: string, text: string, at: string }>}
 */
export function readGenerations(exec) {
  return bucketOf(exec).slice()
}

/** Clear the memory of one Session, or everything when `exec` is omitted. */
export function clearGenerations(exec) {
  if (exec) {
    const bucket = bucketOf(exec)
    bucket.length = 0
    return
  }
  fallback.length = 0
}
