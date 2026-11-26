/**
 * An error whose message is fixed text Fig wrote for the user, free of upstream detail, so a page route may show it
 * as it is. Any other error's message can carry upstream text (and with it credentials) and is never echoed.
 * http.js offers it to the JavaScript packages; TypeScript files import it from here.
 */
export class PublicError extends Error {
  readonly code?: string
  constructor(message: string, code?: string) {
    super(message)
    if (code !== undefined) this.code = code
  }
}
