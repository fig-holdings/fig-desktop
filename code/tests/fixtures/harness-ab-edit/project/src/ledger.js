import { dayKey } from './time.js'

export function parseEvents(text) {
  const events = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const event = JSON.parse(line)
    if (typeof event.ts !== 'string' || typeof event.model !== 'string') { skipped++; continue }
    events.push({ ts: event.ts, model: event.model, input: event.input ?? 0, cached: event.cached ?? 0, output: event.output ?? 0 })
  }
  return { events, skipped }
}

export function summarize(events, { offsetMinutes = 0 } = {}) {
  const days = {}
  for (const event of events) {
    const day = (days[dayKey(event.ts, offsetMinutes)] ??= {})
    const row = (day[event.model] ??= { calls: 0, input: 0, cached: 0, uncached: 0, output: 0 })
    row.calls++
    row.input += event.input + event.cached
    row.cached += event.cached
    row.uncached += event.input
    row.output += event.output
  }
  return days
}

export function topModels(events, n) {
  throw new Error('topModels is not implemented yet')
}

const round = value => Math.round(value * 1e6) / 1e6

export function cost(events, prices) {
  const byModel = {}
  for (const event of events) {
    const price = prices[event.model] ?? { input: 0, cached: 0, output: 0 }
    const uncached = event.input - event.cached
    const amount = (uncached * price.input + event.cached * price.cached + event.output * price.output) / 1e6
    byModel[event.model] = round((byModel[event.model] ?? 0) + amount)
  }
  const total = round(Object.values(byModel).reduce((sum, value) => sum + value, 0))
  return { total, byModel, unknown: [] }
}
