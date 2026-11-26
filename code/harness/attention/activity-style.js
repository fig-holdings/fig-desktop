import {figOrange, figOrangeText as accentText} from '../shared/brand-colors.js'

// Orange text takes the theme's brand text (as figUi's accentText); figOrange stays for focus rings.

// Scoped to Fig's activity panel; deliberately does not target the existing usage component. Cards, figures, the
// ring and group headers are figUi's (ui-kit); this keeps only the panel's own layout and rows. The page column and
// title follow DSH's own pages (schedule `pageContent`/`pageHeading`, plugin `pageTitle`): 960px content between
// clamp(24px,4vw,48px) gutters (20px at 767px and below), a 20/500/28px title 28px below the frame (§4.4); the title and the page's block index stay on top as the page scrolls (§3). The page takes bg-base under figUi's cards, which take
// layer-1 (desktop-skin/client-brand.js surfaceTokens, §4.3).
export const activityStyle = `
[data-fig-activity] .fa-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}
[data-fig-activity] .fa-page{max-width:960px;margin:0 auto;padding:calc(28px + var(--dsh-frame-top-clearance,0px)) clamp(24px,4vw,48px) 48px}
[data-fig-activity] .fa-page-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;margin:calc(-28px - var(--dsh-frame-top-clearance,0px)) 0 16px;padding:calc(28px + var(--dsh-frame-top-clearance,0px)) 0 8px;background:var(--dsw-alias-bg-base)}
[data-fig-activity] .fa-page-head>h1{font-size:20px;font-weight:500;line-height:28px;margin:0}
[data-fig-activity] .fa-head-end{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin-left:auto;min-width:0;max-width:100%}
[data-fig-activity] .fa-head-tools{display:flex;align-items:center;gap:4px;margin-left:auto}
[data-fig-activity] .fa-index{display:flex;flex-wrap:wrap;gap:4px}
[data-fig-activity] .fa-index button{font:inherit;font-size:14px;height:36px;padding:0 18px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
[data-fig-activity] .fa-index button:hover{color:var(--dsw-alias-label-primary)}
[data-fig-activity] .fa-index button[aria-current="true"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:${accentText};font-weight:500}
[data-fig-activity] .fa-index button:focus-visible,[data-fig-activity] .fa-fold:focus-visible{outline:2px solid ${figOrange};outline-offset:2px}
[data-fig-activity] .fa-block{scroll-margin-top:calc(var(--fa-head-height,0px) + 8px);margin:0 0 24px}
[data-fig-activity] .fa-block-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:0 0 12px}
[data-fig-activity] .fa-block-head>span{font-size:11px;color:var(--dsw-alias-label-secondary)}
[data-fig-activity] .fa-fold{display:inline-flex;align-items:center;gap:6px;font:inherit;color:inherit;background:transparent;border:0;padding:2px 4px 2px 0;cursor:pointer;border-radius:6px}
[data-fig-activity] .fa-fold>svg{color:var(--dsw-alias-label-secondary);transition:transform .15s}
[data-fig-activity] .fa-fold[aria-expanded="false"]>svg{transform:rotate(-90deg)}
[data-fig-activity] .fa-fold>h2{font-size:15px;font-weight:600;margin:0}
@media(prefers-reduced-motion:reduce){[data-fig-activity] .fa-fold>svg{transition:none}}
@media(max-width:767px){[data-fig-activity] .fa-page{padding-inline:20px}}
[data-fig-activity]{background:var(--dsw-alias-bg-base)}
[data-fig-activity] .fa-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
[data-fig-activity] .fa-tools select{max-width:200px}
[data-fig-activity] .fa-overview{display:grid;grid-template-columns:1.6fr repeat(var(--fa-metrics,4),minmax(0,1fr));gap:8px;margin-bottom:28px}
[data-fig-activity] .fa-views{display:inline-flex;gap:2px;padding:2px;margin:-8px 0 20px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
[data-fig-activity] .fa-views button{font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;border-radius:6px;padding:4px 12px;cursor:pointer}
[data-fig-activity] .fa-views button[aria-selected="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
[data-fig-activity] .fa-views button:focus-visible{outline:2px solid ${figOrange};outline-offset:2px}
[data-fig-activity] .fa-info .fig-ui-tag{flex:0 1 auto}
[data-fig-activity] .fa-board{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:0 0 16px}
[data-fig-activity] .fa-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 14px;min-height:54px;border-bottom:1px solid var(--dsw-alias-border-l2)}
[data-fig-activity] .fa-row:last-child{border-bottom:0}
[data-fig-activity] .fa-info{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;min-width:0;flex:1}
[data-fig-activity] .fa-title{font:inherit;font-size:13px;font-weight:500;cursor:pointer;color:inherit;background:transparent;border:0;padding:0;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 130px;min-width:0}
[data-fig-activity] .fa-meta{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
[data-fig-activity] .fa-actions{display:flex;gap:9px;align-items:center;flex-shrink:0}
[data-fig-activity] .fa-action{font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;padding:5px 0;cursor:pointer}
[data-fig-activity] .fa-open{font-size:17px;padding:4px}
[data-fig-activity] .fa-more{position:relative}
[data-fig-activity] .fa-more summary{cursor:pointer;list-style:none;font-size:16px;padding:2px 4px}
[data-fig-activity] .fa-more summary::-webkit-details-marker{display:none}
[data-fig-activity] .fa-menu{position:absolute;right:0;top:100%;z-index:4;min-width:180px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1,Canvas);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 6px 20px #0002;display:grid;gap:4px}
[data-fig-activity] .fa-known{border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}
[data-fig-activity] .fa-known>summary{font-size:12px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
[data-fig-activity] .fa-known .fa-row{align-items:start;flex-wrap:wrap}
[data-fig-activity] .fa-title:hover,[data-fig-activity] .fa-action:hover{color:${accentText}}
[data-fig-activity] .fa-title:focus-visible,[data-fig-activity] .fa-action:focus-visible,[data-fig-activity] .fa-more summary:focus-visible,[data-fig-activity] .fa-tools select:focus-visible{outline:2px solid ${figOrange};outline-offset:3px}
@media(max-width:760px){[data-fig-activity] .fa-overview{grid-template-columns:repeat(4,minmax(0,1fr))}[data-fig-activity] .fa-attention{grid-column:1/-1}}
@media(max-width:560px){[data-fig-activity] .fa-board{grid-template-columns:1fr}[data-fig-activity] .fa-overview{grid-template-columns:repeat(2,minmax(0,1fr))}}
`
