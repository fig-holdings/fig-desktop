// Fig's two brand colours that page plugins write as literals (CSS strings, inline styles), kept in one place so the
// copies cannot drift. Theme-dependent shades stay with their users (desktop-skin/client-brand.js).

/** Fig orange: the accent, focus ring and primary-button fill in both themes. */
export const figOrange = '#ff6a1a'
/** Orange *text*: the theme's brand text (#b64000 light, #ff8a4c dark, desktop-skin/client-brand.js); the light value
 * outside Fig. #ff6a1a itself is below 3:1 on the light surfaces. */
export const figOrangeText = 'var(--dsw-alias-brand-text, #b64000)'
/** Fig's danger red, for failures and blocked states in both themes. */
export const figDanger = '#db5555'
