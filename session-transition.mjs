// Serializes session replacement while keeping stale ACP continuations harmless.
export function createSessionTransition() {
  let epoch = 0
  let replacing = false
  let activeTurn = null
  let replacementTail = Promise.resolve()

  const current = (lease) => lease === epoch

  function startTurn(cancel) {
    // Do not replace an unsettled turn. Abort may make the UI interactive before
    // ACP has acknowledged cancellation; replacement must still be able to await it.
    if (replacing || activeTurn) return null
    const lease = epoch
    let resolveSettled
    const turn = {
      lease,
      cancelled: null,
      settled: new Promise((resolve) => { resolveSettled = resolve }),
      finish() {
        resolveSettled()
        if (activeTurn === turn) activeTurn = null
      },
    }
    turn.cancel = () => {
      if (!turn.cancelled) turn.cancelled = Promise.resolve().then(cancel).catch(() => {})
      return turn.cancelled
    }
    activeTurn = turn
    return turn
  }

  function replace(work, ownerTurn = null) {
    const lease = ++epoch // synchronous invalidation: every prior ACP continuation is stale now
    replacing = true
    const priorTurn = activeTurn
    // A setup turn can trigger a restart from its post-prompt barrier. It still
    // owns activeTurn until that barrier returns, so it must explicitly adopt
    // the replacement rather than cancel and await itself.
    if (priorTurn && priorTurn !== ownerTurn) priorTurn.cancel() // start cancellation before waiting for the serialized slot
    const run = replacementTail.then(async () => {
      if (priorTurn && priorTurn !== ownerTurn) { await priorTurn.cancelled; await priorTurn.settled }
      if (!current(lease)) return undefined
      return await work(lease)
    })
    replacementTail = run.then(() => {}, () => {})
    return run.finally(() => { if (current(lease)) replacing = false })
  }

  return { current, startTurn, replace, get activeTurn() { return activeTurn }, get replacing() { return replacing }, get epoch() { return epoch } }
}
