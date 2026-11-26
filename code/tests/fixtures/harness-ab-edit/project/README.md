# usage-ledger

Aggregates model usage events (JSON Lines) into per-day, per-model totals and costs.

## Event format

One JSON object per line: `{ "ts": "<ISO 8601>", "model": "<id>", "input": <int>, "cached": <int>, "output": <int> }`.
`input` counts all prompt tokens and **includes** `cached`; cached tokens are a subset of input, never extra.

## Behaviour

- `parseEvents(text)` returns `{ events, skipped }`. Blank lines are ignored. A line that is not valid JSON,
  or lacks a string `ts`/`model`, is skipped and counted in `skipped`; it never throws.
- `dayKey(ts, offsetMinutes = 0)` returns the local calendar date `YYYY-MM-DD` at the given UTC offset in
  minutes (e.g. `480` for UTC+8, `-300` for UTC-5).
- `summarize(events, { offsetMinutes = 0 })` returns `{ [day]: { [model]: { calls, input, cached, uncached, output } } }`
  where `input` and `cached` are plain sums and `uncached = input - cached`.
- `topModels(events, n)` returns up to `n` model ids ordered by total tokens (`input + output`) descending;
  ties are broken by model id ascending. `n <= 0` returns `[]`.
- `cost(events, prices)` uses `prices[model] = { input, cached, output }` in USD per million tokens:
  uncached input at `input`, cached at `cached`, output at `output`. It returns `{ total, byModel, unknown }`.
  A model without a price is listed in `unknown` and has `byModel[model] = null`; an unknown cost is not
  zero, so `total` is `null` whenever `unknown` is not empty. Amounts are rounded to 6 decimals.
