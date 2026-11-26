export const css = `
.fig-nav-dot{position:relative;display:inline-block;box-sizing:border-box;width:6px;height:6px;border:1.25px solid var(--fig-project-color);border-radius:50%;background:var(--fig-project-color);flex:none}
.fig-nav-dot[data-state=running],.fig-nav-dot[data-state=waiting]{background:transparent}
.fig-nav-dot[data-state=running]:after{content:'';position:absolute;inset:-3px;border:1px solid var(--fig-project-color);border-radius:50%;animation:fig-nav-pulse 2s ease-out infinite}
@keyframes fig-nav-pulse{0%{transform:scale(.7);opacity:.65}100%{transform:scale(1.5);opacity:0}}
@media(prefers-reduced-motion:reduce){.fig-nav-dot[data-state=running]:after{animation:none;opacity:.35}}
[data-fig-project-cell]{position:relative}
[data-fig-project-cell]>[data-fig-nav-host]{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
[data-fig-project-cell=replace]>:not([data-fig-nav-host]){visibility:hidden}
[data-fig-project-cell=preserve]>[data-fig-nav-host]{justify-content:flex-start;transform:translateX(-5px)}
[data-fig-project-cell=preserve]>:not([data-fig-nav-host]){transform:translateX(4px) scale(.75)}
[data-fig-project-icon]>:not([data-fig-nav-host]){display:none}
[data-fig-project-icon]>[data-fig-nav-host]{display:flex}
[data-slot="sidebar.workspaces"] [class*="_rail"]>[class*="_search"]{order:0}
[data-fig-nav-rail-host]{order:1;min-height:0;overflow:auto}
[data-slot="sidebar.workspaces"] [class*="_rail"]>[class*="_listArea"]{order:2}
.fig-nav-rail{display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 0;max-height:100%;overflow-y:auto}
.fig-nav-divider{width:20px;border:0;border-top:1px solid var(--dsw-alias-border-l2,#8884);margin:0 0 4px}
.fig-nav-button{width:32px;height:32px;padding:0;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;justify-content:center;cursor:pointer;font:inherit;flex:none}
.fig-nav-button:hover,.fig-nav-button[aria-current=true]{background:var(--dsw-alias-interactive-bg-hover,#8882)}
.fig-nav-button:focus-visible,.fig-nav-dialog button:focus-visible,.fig-nav-menu button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#58abef);outline-offset:2px}
.fig-nav-popover{position:fixed;z-index:10020;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#262626);color:var(--dsw-alias-label-primary);box-shadow:0 8px 32px #0003;font:13px/1.5 system-ui}
.fig-nav-tooltip{padding:8px 10px;max-width:min(300px,calc(100vw - 16px));white-space:pre-line;overflow-wrap:anywhere;pointer-events:none}
.fig-nav-menu{width:min(280px,calc(100vw - 72px));padding:6px}
.fig-nav-menu button{display:flex;align-items:center;gap:12px;width:100%;padding:10px;border:0;border-radius:6px;background:transparent;text-align:left;color:inherit;cursor:pointer;font:inherit;min-width:0}
.fig-nav-menu button:hover,.fig-nav-menu button:focus{background:var(--dsw-alias-interactive-bg-hover,#8882)}
.fig-nav-menu-label{min-width:0;display:flex;flex-direction:column}
.fig-nav-menu-label>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fig-nav-menu-label small{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fig-nav-overlay{position:fixed;inset:0;z-index:10030;background:#0005;display:grid;place-items:center;padding:16px}
.fig-nav-dialog{position:relative;width:min(380px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:20px;font:14px/1.5 system-ui}
.fig-nav-dialog h2{font-size:18px;margin:0 0 4px}.fig-nav-dialog p{margin:0 0 16px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.fig-nav-colors{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:5px;margin:16px 0}
.fig-nav-colors button{width:30px;height:30px;border:3px solid transparent;border-radius:50%;background:var(--fig-project-color);cursor:pointer;justify-self:center}
.fig-nav-colors button[aria-pressed=true]{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.fig-nav-icons{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:4px;max-height:256px;overflow-y:auto;padding:3px;margin:-3px;scrollbar-width:thin}
.fig-nav-icons button{width:100%;height:32px;border:1px solid transparent;border-radius:8px;display:grid;place-items:center;background:transparent;color:var(--fig-project-color);cursor:pointer}
.fig-nav-icons button:hover,.fig-nav-icons button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover,#8882);border-color:var(--dsw-alias-border-l2,#8884)}
.fig-nav-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:20px;flex-wrap:wrap}
.fig-nav-actions button{padding:6px 12px;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:inherit}
.fig-nav-actions button:last-child{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base,#262626)}
.fig-nav-dialog button:disabled{opacity:.5;cursor:default}
`
