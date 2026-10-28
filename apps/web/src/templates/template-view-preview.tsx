import { PRINT_PALETTE } from '@nix/design-tokens/print';
import { Text } from '@nix/ui';
import { renderView } from '@nix/view-render';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { isCanceledError } from '@nix/api-client';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { templateById, type TemplateDetail } from './template-api';

type PreviewStatus = 'loading' | 'ready' | 'error';
const PREVIEW_ROW_LIMIT = 12;

export function TemplateViewPreview({
  templateId,
  title,
}: {
  readonly templateId: string;
  readonly title: string;
}): ReactNode {
  const client = useApiClient();
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<PreviewStatus>('loading');
  const [detail, setDetail] = useState<TemplateDetail | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    if (typeof IntersectionObserver === 'undefined') {
      queueMicrotask(() => {
        setVisible(true);
      });
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: '200px' },
    );
    observer.observe(host);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    void client
      .query(templateById(templateId), { signal: controller.signal })
      .then((loaded) => {
        setDetail(loaded);
        setStatus('ready');
      })
      .catch((reason: unknown) => {
        if (isCanceledError(reason)) return;
        setStatus('error');
      });
    return () => {
      controller.abort();
    };
  }, [client, templateId, visible]);

  let preview: ReactNode;

  if (status === 'loading') {
    preview = (
      <div className="flex h-36 items-center justify-center rounded-md bg-surface" aria-busy="true">
        <Text variant="caption" tone="muted">
          Loading preview
        </Text>
      </div>
    );
  } else if (status === 'error' || detail === null) {
    preview = (
      <div className="flex h-36 items-center justify-center rounded-md bg-surface">
        <Text variant="caption" tone="muted">
          Preview unavailable
        </Text>
      </div>
    );
  } else {
    const offered = detail.root.views?.views ?? [];
    const defaultViewId = detail.root.views?.default;
    const view = offered.find((candidate) => candidate.id === defaultViewId) ?? offered[0];
    if (view === undefined) {
      preview = (
        <div className="flex h-36 items-center justify-center rounded-md bg-surface">
          <Text variant="caption" tone="muted">
            No child-item view in this template
          </Text>
        </div>
      );
    } else {
      const drawn = renderView({
        view,
        rows: detail.root.children.slice(0, PREVIEW_ROW_LIMIT).map((child) => ({
          id: child.sourceId,
          title: child.title,
          properties: child.properties ?? {},
        })),
        schema: detail.root.schema ?? null,
        palette: PRINT_PALETTE,
        width: 480,
      });
      const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(drawn.svg)}`;
      preview = (
        <figure className="h-36 overflow-hidden rounded-md bg-surface" title={`${view.name} view`}>
          <img
            src={source}
            alt={`${title} template preview, ${view.name} view`}
            className="h-full w-full object-cover object-top"
          />
        </figure>
      );
    }
  }

  return <div ref={hostRef}>{preview}</div>;
}
