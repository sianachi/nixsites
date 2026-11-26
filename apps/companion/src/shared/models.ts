/** Anthropic's fast model: what chat uses unless the pet or the message picks another. */
export const ANTHROPIC_CHAT_MODEL = 'claude-haiku-5-5';

/** The larger model a plan, a task run or a "think harder" message uses, per provider. OpenRouter has none: its owner picks the model. */
export const DEEP_MODELS: Readonly<Record<string, string>> = { anthropic: 'claude-sonnet-5-5' };

/** The providers a pet can use. */
export const PROVIDERS: readonly string[] = ['anthropic', 'openrouter'];

/**
 * The `thinking` setting that turns reasoning off on a model whose default is on, so a tool
 * round can be replayed without its thinking blocks. Haiku 5.5 takes `disabled`; Sonnet 5.5
 * rejects it and takes `between_tools`. Other models are sent without one.
 */
export const THINKING_OFF: Readonly<Record<string, { type: string }>> = {
  'claude-haiku-5-5': { type: 'disabled' },
  'claude-sonnet-5-5': { type: 'between_tools' },
};
