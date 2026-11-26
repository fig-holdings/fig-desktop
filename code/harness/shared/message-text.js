/** The text blocks of `content`, joined by newlines as they are; '' for anything else. */
export const joinedText = content => (Array.isArray(content) ? content : [])
  .filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')

/** The text blocks of a message's `content`, joined by newlines and trimmed; '' for anything else. */
export const contentText = content => joinedText(content).trim()
