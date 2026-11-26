// Line icons for the 研发工作台, drawn on a 24-unit grid in the current text color (lucide-style strokes, own paths).

/** @type {Record<string, (string | [string, Record<string, number>])[]>} */
const shapes = {
  repository: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14Z', 'M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5', 'M9 7h7'],
  folder: ['M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z'],
  branch: [['circle', { cx: 6, cy: 18, r: 2.5 }], ['circle', { cx: 6, cy: 6, r: 2.5 }], ['circle', { cx: 18, cy: 6, r: 2.5 }], 'M6 8.5v7', 'M18 8.5a7 7 0 0 1-7 7H8.5'],
  remote: ['M17.5 19H8a6 6 0 1 1 5.7-7.9h1.8a4 4 0 1 1 2 7.9Z'],
  uncommitted: ['M14 3H6.5A2.5 2.5 0 0 0 4 5.5v13A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V9Z', 'M14 3v6h6', 'M12 11v5', 'M9.5 13.5h5', 'M9.5 18h5'],
  compare: [['circle', { cx: 18, cy: 18, r: 2.5 }], ['circle', { cx: 6, cy: 6, r: 2.5 }], 'M13 6h3a2 2 0 0 1 2 2v7.5', 'M11 18H8a2 2 0 0 1-2-2V8.5'],
  commit: [['circle', { cx: 12, cy: 12, r: 3 }], 'M3 12h6', 'M15 12h6'],
  pull: [['circle', { cx: 6, cy: 6, r: 2.5 }], ['circle', { cx: 18, cy: 18, r: 2.5 }], 'M6 8.5V21', 'M18 15.5V8.5a2.5 2.5 0 0 0-2.5-2.5H11', 'M13.5 3.5 11 6l2.5 2.5'],
  terminal: ['m5 17 5-5-5-5', 'M12 19h7'],
  finished: [['circle', { cx: 12, cy: 12, r: 8.5 }], 'm8.5 12 2.5 2.5 4.5-5'],
  output: ['M4 6h16', 'M4 12h10', 'M4 18h7'],
  tasks: ['M10 6h10', 'M10 12h10', 'M10 18h10', 'm3.5 6 1.5 1.5L7.5 5', 'm3.5 12 1.5 1.5L7.5 11', ['circle', { cx: 5, cy: 18, r: 1.3 }]],
  finder: ['M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v1', 'M3 7.5v10A2.5 2.5 0 0 0 5.5 20h12.6a2 2 0 0 0 1.9-1.4l1.5-5A2 2 0 0 0 19.6 11H8.4a2 2 0 0 0-1.9 1.4L4.4 19'],
  open: ['M14 4h6v6', 'M20 4 10 14', 'M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10'],
  copy: [['rect', { x: 8, y: 8, width: 12, height: 12, rx: 2 }], 'M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8'],
  chevron: ['m9 6 6 6-6 6'],
  push: ['M12 19V6', 'm6.5 11.5 5.5-5.5 5.5 5.5', 'M5 21h14'],
  sync: ['M12 4v16', 'm8 8 4-4 4 4', 'm8 16 4 4 4-4'],
  merge: [['circle', { cx: 6, cy: 6, r: 2.5 }], ['circle', { cx: 6, cy: 18, r: 2.5 }], ['circle', { cx: 18, cy: 12, r: 2.5 }], 'M6 8.5v7', 'M6 8.5a6 6 0 0 0 6 3.5h3.5'],
  agent: ['M12 3v3', ['rect', { x: 5, y: 6, width: 14, height: 12, rx: 3 }], ['circle', { cx: 9.5, cy: 12, r: 1 }], ['circle', { cx: 14.5, cy: 12, r: 1 }], 'M9 21h6'],
  auto: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6']
}

export const iconNames = Object.keys(shapes)

/**
 * An icon component. @param {typeof import('react').createElement} h
 * @returns {(props: { name: string, size?: number, color?: string, style?: any }) => any}
 */
export function iconFactory(h) {
  return function Icon({ name, size = 14, color, style }) {
    const parts = shapes[name] ?? []
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color ?? 'currentColor', strokeWidth: 1.8,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', 'data-fig-icon': name, style: { flex: 'none', ...style } },
    parts.map((part, index) => typeof part === 'string' ? h('path', { key: index, d: part }) : h(part[0], { key: index, ...part[1] })))
  }
}
