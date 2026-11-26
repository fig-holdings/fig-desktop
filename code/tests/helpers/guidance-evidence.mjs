/** Require a correlated successful preview result and a reported measured fact.
 * Format contract: Fig 0.1.36 fig-preview capture.js diagnostics under DSH 0.2.2-rc.1.
 * Upgrade review must recheck Preview of / 390px: / overflow wording; changes fail closed.
 */
export function guidanceDiagnostics(output, events) {
  const calls = events.filter(event => event.type === 'tool/call' && event.data.name === 'preview')
  const ids = new Set(calls.map(event => event.data.callId))
  const results = events.filter(event => event.type === 'tool/result' && !event.data.message?.isError && ids.has(event.data.message?.toolCallId))
  const text = results.map(event => (event.data.message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')).filter(text => text.startsWith('Preview of '))
  const narrow = text.flatMap(report => report.split('\n').filter(line => /^390px:/.test(line))).at(-1)
  let referenced = false
  if (narrow?.includes('no horizontal overflow')) referenced = /no horizontal overflow|无横向溢出|没有横向溢出|未发现横向溢出/i.test(output)
  const overflow = narrow?.match(/HORIZONTAL OVERFLOW (\d+)px/)
  if (overflow) referenced = output.includes(overflow[1]) && /overflow|溢出/i.test(output)
  return { previewCalls: calls.length, diagnostics: text.length, narrowObserved: Boolean(narrow), diagnosticReferenced: referenced }
}
