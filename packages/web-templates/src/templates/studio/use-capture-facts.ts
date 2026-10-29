import { useEffect, type Dispatch, type SetStateAction } from 'react';

import { isCanceledError, type NixClient } from '@nix/api-client';

import { templateCaptureSourceSchema, templateCaptureSourceViews } from '../template-api';
import { distinctViewKinds, type CaptureFacts, type StudioMode } from '../template-studio-model';

/** Reads the field and view counts of the item being captured. */
export function useCaptureFacts(
  client: NixClient,
  mode: StudioMode,
  sourceItemId: string | null,
  setCaptureFacts: Dispatch<SetStateAction<CaptureFacts>>,
): void {
  useEffect(() => {
    if (mode !== 'capture' || sourceItemId === null) return;
    const controller = new AbortController();
    void Promise.all([
      client.query(templateCaptureSourceSchema(sourceItemId), { signal: controller.signal }),
      client.query(templateCaptureSourceViews(sourceItemId), { signal: controller.signal }),
    ])
      .then(([schema, views]) => {
        setCaptureFacts({
          status: 'ready',
          fieldCount: schema.properties.length,
          viewCount: views.views.length,
          viewKinds: distinctViewKinds(views.views),
        });
      })
      .catch((reason: unknown) => {
        if (!isCanceledError(reason)) setCaptureFacts({ status: 'error' });
      });
    return () => {
      controller.abort();
    };
  }, [client, mode, sourceItemId, setCaptureFacts]);
}
