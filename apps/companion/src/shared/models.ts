/** Anthropic's fast model: what chat uses unless the pet or the message picks another. */
export const ANTHROPIC_CHAT_MODEL = 'claude-haiku-5-5';

/** The larger model a plan, a task run or a "think harder" message uses, per provider. OpenRouter has none: its owner picks the model. */
export const DEEP_MODELS: Readonly<Record<string, string>> = { anthropic: 'claude-sonnet-5-5' };

/** The providers a pet can use. */
export const PROVIDERS: readonly string[] = ['anthropic', 'openrouter'];

/**
 * The `thinking` setting a model is sent. Haiku 5.5 (chat) takes `disabled`. Sonnet 5.5, the
 * deeper model for think-harder, plans and task runs, thinks adaptively and returns summaries
 * (`display` defaults to omitted there), which the reasoning line shows; its blocks are replayed
 * inside the turn's tool rounds only. Other models are sent without one.
 */
export const THINKING: Readonly<Record<string, { type: string; display?: string }>> = {
  'claude-haiku-5-5': { type: 'disabled' },
  'claude-sonnet-5-5': { type: 'adaptive', display: 'summarized' },
};
