type Reasoning = { efforts: { id: string }[], defaultEffort?: string }

/** Both subscriptions (ChatGPT, Grok) default to Medium when a model offers it, otherwise to the service's own default. */
export function mediumDefault<R extends Reasoning>(reasoning: R): R
export function mediumDefault<R extends Reasoning>(reasoning: R | undefined): R | undefined
export function mediumDefault<R extends Reasoning>(reasoning: R | undefined): R | undefined {
  return reasoning?.efforts.some(({ id }) => id === 'medium') ? { ...reasoning, defaultEffort: 'medium' } : reasoning
}
