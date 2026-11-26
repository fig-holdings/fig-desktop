// Calendar helpers for the ledger.

export function pad(value) {
  return String(value).padStart(2, '0')
}

/** Local calendar date of an instant at a fixed UTC offset, as YYYY-MM-DD. */
export function dayKey(ts, offsetMinutes = 0) {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${ts}`)
  return date.toISOString().slice(0, 10)
}
