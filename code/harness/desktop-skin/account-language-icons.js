// Identical language marks for Fig's legacy menu augmentation and Cowork's native Menu.
// Keep the leading glyph independent of the current-selection checkmark.
const paths = {
  zh: 'M3 5h10v6H3z M8 2.5v11',
  en: 'm3 13 5-10 5 10 M5 9h6'
}

export function languageIconMarkup(id) {
  const path = id === 'zh' ? paths.zh : paths.en
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${path}" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

export function languageIcon(h, id) {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', { d: id === 'zh' ? paths.zh : paths.en, stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}
