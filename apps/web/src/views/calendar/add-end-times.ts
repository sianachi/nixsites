import { isNixApiError, structure as coreStructure, views as coreViews } from '@nix/api-client';

import type { useApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  ContainerViewsSchema,
  EffectiveSchemaSchema,
  toViewRequest,
} from '../../collections/core/container-model';

/**
 * Gives a container's calendar an end property, from outside that container's own page.
 *
 * The container's calendar view does this through the container it already holds. The collated
 * calendar holds entries from many containers and none of their schemas, so it reads the one it
 * needs, adds an "End" property shaped like the start, and points the calendar view at it - in the
 * same single write, for the same reason: a property added without the view using it would leave
 * the reader with no sign of why items still cannot be stretched.
 *
 * "The calendar view" is the container's first one, which is the one the workspace calendar itself
 * places that container's items by.
 *
 * Returns why it could not be done, or null when it was - or when there was nothing to do.
 */
export async function addEndTimes(
  client: ReturnType<typeof useApiClient>,
  containerId: string,
): Promise<string | null> {
  try {
    const [schemaRead, viewsRead] = await Promise.all([
      client.query(coreStructure.effectiveSchema(containerId), { forceRefresh: true }),
      client.query(coreViews.containerViewConfigurations(containerId), { forceRefresh: true }),
    ]);
    const schema = EffectiveSchemaSchema.safeParse(schemaRead);
    const views = ContainerViewsSchema.safeParse(viewsRead);
    if (!schema.success || !views.success) {
      return 'This calendar’s setup could not be read, so it was left as it is.';
    }

    const view = views.data.views.find((candidate) => candidate.kind === 'calendar');
    if (view === undefined) {
      return 'That item has no calendar view to add end times to.';
    }
    if (view.endDateProperty !== null) {
      return null;
    }

    // The end has to be the same kind of value as the start - a day or a moment - or the two
    // could not be compared. A computed start has no shape a stored end could share.
    const start = schema.data.properties.find((property) => property.key === view.dateProperty);
    if (start?.expression !== null) {
      return 'This calendar places items by a property an end cannot be matched to. Choose an End property in its view settings instead.';
    }

    const taken = new Set(schema.data.properties.map((property) => property.key));
    let key = 'end';
    for (let suffix = 2; taken.has(key); suffix += 1) {
      key = `end_${String(suffix)}`;
    }

    await client.execute(
      coreViews.replaceViewSetup(containerId, view.id, {
        schema: {
          inherit: schema.data.inherit,
          properties: [
            ...schema.data.declared,
            { ...start, key, label: 'End', required: false },
          ].map((property) => ({
            ...property,
            options: property.options.length === 0 ? null : property.options,
            choiceSource: property.choiceSource ?? null,
          })),
        },
        originalPropertyKeys: schema.data.declared.map((property) => property.key),
        views: [toViewRequest({ ...view, endDateProperty: key })],
        publishInteractiveFormViewId: null,
      }),
    );
    return null;
  } catch (reason) {
    return isNixApiError(reason)
      ? (reason.detail ?? 'End times could not be added to this calendar.')
      : 'End times could not be added. Check the connection and try again.';
  }
}
