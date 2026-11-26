// DSH's turn rail for a long conversation (every turn as a mark, a preview card on hover, click to jump) sits in the
// right gutter and hides below a 900px conversation, which is most of Fig's layouts. Fig moves it to the left edge and
// shows it down to a 520px conversation. The rail and its preview are DSH's own; only their placement changes.
// Earlier history loads on scroll natively in the verified DSH; Fig's own paging for 0.2.2-rc.1 is at tag dsh-compat/0.2.2-rc.1.

export const transcriptCss = `
@container (width > 520px) { [data-slot="main.conversation"] nav[class*="_frame"] { display: block; } }
[data-slot="main.conversation"] nav[class*="_frame"] { left: 6px; right: auto; }
[data-slot="main.conversation"] nav[class*="_frame"] button[class*="_mark"]::before { left: 0; right: auto; transform-origin: 0 50%; }
[data-slot="main.conversation"] nav[class*="_frame"] button[class*="_mark"]:focus-visible::after { left: 0; right: auto; }
[data-slot="main.conversation"] nav[class*="_frame"] [role="tooltip"] { left: calc(100% + 10px); right: auto; }
`

export function installTranscript(doc = document) {
  const style = doc.createElement('style')
  style.id = 'fig-transcript-style'
  style.textContent = transcriptCss
  doc.head.append(style)
  return () => style.remove()
}
