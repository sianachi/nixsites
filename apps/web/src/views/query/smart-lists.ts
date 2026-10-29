import { isNixApiError, views as coreViews, type NixClient } from '@nix/api-client';
import { type SmartListPreset, smartListView } from '@nix/structure-spec';

import { toViewRequest } from '../../collections/core/container-model';

/**
 * `SmartListPreset`, `SMART_LISTS`, `findSmartList` and `smartListView` moved to
 * `@nix/structure-spec` (task 0.3 of the pet structure-tools plan): pure vocabulary the pet's
 * structure compiler needs too. `applySmartList` stays here - it needs a `NixClient`, which
 * `@nix/structure-spec` may not depend on.
 */
export { findSmartList, SMART_LISTS, smartListView } from '@nix/structure-spec';
export type { SmartListPreset } from '@nix/structure-spec';

/**
 * Stores a preset's query view on a freshly created item, so opening it lands on the results.
 *
 * Uses the configured API client so the view write shares the application's authentication, error
 * mapping and response parsing path. Returns the refusal, or null when stored - an item created but
 * left without its view is still a working item whose view can be added by hand, which is why the
 * caller reports rather than rolls back.
 */
export async function applySmartList(
  itemId: string,
  preset: SmartListPreset,
  client: NixClient,
): Promise<string | null> {
  try {
    await client.execute(
      coreViews.setContainerViews(itemId, {
        views: [toViewRequest(smartListView(preset))],
        default: 'query',
      }),
    );
    return null;
  } catch (reason) {
    if (isNixApiError(reason) && reason.detail !== undefined) {
      return reason.detail;
    }
    return 'The smart list was created but its filters could not be sent. Configure them under Views.';
  }
}
