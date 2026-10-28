import type { ReactElement } from 'react';

import { MentionBubbleView } from './mention-bubble';

export default { title: 'Nix/Editor/Mention bubble', parameters: { layout: 'fullscreen' } };

/**
 * The offer an underlined item name makes once the caret is moved into it: link it, or stop
 * suggesting it here. Positioned by the editor from the caret; fixed here so both placements show.
 */
function Example({ above }: { readonly above: boolean }): ReactElement {
  return (
    <div className="relative min-h-40 p-4">
      <MentionBubbleView
        title="Project Atlas"
        position={{ left: 16, top: above ? 120 : 16, maxWidth: 360 }}
        above={above}
        onLink={() => undefined}
        onDismiss={() => undefined}
      />
    </div>
  );
}

/** Below the caret, where there is room. */
export const Shown = { render: (): ReactElement => <Example above={false} /> };

/** Above the caret, near the bottom of the viewport. */
export const Above = { render: (): ReactElement => <Example above /> };
