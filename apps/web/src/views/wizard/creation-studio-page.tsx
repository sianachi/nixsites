import { Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router';

import { browserSessionStorage } from '@nix/web-foundation/lib/browser-storage';
import type { ShellContext } from '../../shell/shell-context';
import { useWorkspace } from '../../workspaces/workspace-context';
import { useContainer } from '../core/use-container';
import { CreationStudioFrame } from './creation-studio-frame';
import { BasicsStep, OptionsStep } from './creation-studio-steps';
import {
  FALLBACK_RECIPE,
  compiledViews,
  draftFor,
  draftKey,
  readDraft,
  uniqueIdentifier,
  validateDraft,
  type StudioDraft,
  type StudioIntent,
} from './creation-studio-model';
import { findStructuredRecipe, viewForRecipe } from './structured-recipes';

export function CreationStudioPage(): ReactNode {
  const { recipe, itemId, viewId } = useParams();
  const [searchParams] = useSearchParams();
  const scope = `${recipe ?? 'unknown'}:${itemId ?? 'new'}:${viewId ?? 'new'}:${searchParams.get('parent') ?? 'root'}`;
  return <CreationStudio key={scope} />;
}

function CreationStudio(): ReactNode {
  const { recipe: recipeId, itemId, viewId } = useParams();
  const recipe = findStructuredRecipe(recipeId);
  const [searchParams] = useSearchParams();
  const parentId = searchParams.get('parent');
  const draftScope = viewId === undefined ? (itemId ?? parentId) : `${itemId ?? 'item'}:${viewId}`;
  const { tree } = useOutletContext<ShellContext>();
  const { workspaceId } = useWorkspace();
  const targetContainer = useContainer(itemId ?? null);
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [discarding, setDiscarding] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<StudioDraft>(() =>
    recipe === null ? draftFor(FALLBACK_RECIPE) : readDraft(recipe, draftScope),
  );
  const seededEdit = useRef<string | null>(null);

  useEffect(() => {
    if (itemId === undefined || targetContainer.status !== 'ready') return;
    const activeRecipe = recipe ?? FALLBACK_RECIPE;
    const seedKey = viewId ?? `new:${itemId}`;
    if (seededEdit.current === seedKey) return;
    if (browserSessionStorage()?.getItem(draftKey(activeRecipe, draftScope)) != null) {
      seededEdit.current = seedKey;
      return;
    }

    const takenViewIds = new Set(targetContainer.views?.views.map((entry) => entry.id) ?? []);
    if (viewId === undefined) {
      const initial = draftFor(activeRecipe);
      const existingKeys = new Set(
        targetContainer.schema?.properties.map((property) => property.key) ?? [],
      );
      const properties = initial.properties.map((property) => {
        const key = uniqueIdentifier(property.key, existingKeys);
        existingKeys.add(key);
        return { ...property, key };
      });
      const view = viewForRecipe(activeRecipe, properties);
      const id = uniqueIdentifier(view.id, takenViewIds);
      takenViewIds.add(id);
      const companionViewId = uniqueIdentifier(`${id}-companion`, takenViewIds);
      queueMicrotask(() => {
        seededEdit.current = seedKey;
        setDraft({
          ...initial,
          properties,
          view: { ...view, id },
          companionView: null,
          companionViewId,
        });
      });
      return;
    }

    const stored = targetContainer.views?.views.find((view) => view.id === viewId);
    if (stored === undefined) return;
    const companion = targetContainer.views?.views.find(
      (view) => view.id === stored.companionViewId,
    );
    const companionKind = companion?.kind ?? null;
    queueMicrotask(() => {
      seededEdit.current = seedKey;
      setDraft({
        title: stored.name,
        properties: targetContainer.schema?.declared ?? [],
        view: stored,
        companionKind,
        companionView: companion ?? null,
        companionViewId: companion?.id ?? uniqueIdentifier(`${stored.id}-companion`, takenViewIds),
        companionPlacement: stored.companionPlacement ?? 'below',
        publish: false,
      });
    });
  }, [
    draftScope,
    itemId,
    recipe,
    targetContainer.schema,
    targetContainer.status,
    targetContainer.views,
    viewId,
  ]);

  useEffect(() => {
    if (recipe === null) return;
    // An existing-item studio starts with the recipe's placeholder while its container loads.
    // Persisting that placeholder would make the seeding effect mistake it for a recovered draft
    // and permanently hide the stored view configuration.
    if (itemId !== undefined && seededEdit.current === null) return;
    browserSessionStorage()?.setItem(draftKey(recipe, draftScope), JSON.stringify(draft));
  }, [draft, draftScope, itemId, recipe]);

  useEffect(() => {
    function warn(event: BeforeUnloadEvent): void {
      event.preventDefault();
    }
    globalThis.addEventListener('beforeunload', warn);
    return () => {
      globalThis.removeEventListener('beforeunload', warn);
    };
  }, []);

  if (recipe === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Text variant="bodySmall" tone="muted">
          This guided setup is not available.
        </Text>
      </div>
    );
  }

  const destination =
    itemId !== undefined
      ? (tree.find(itemId)?.title ?? 'Current item')
      : parentId === null
        ? 'Workspace root'
        : (tree.find(parentId)?.title ?? 'Current item');
  const intent: StudioIntent =
    itemId === undefined ? 'create' : viewId === undefined ? 'add' : 'edit';
  const existingProperties = targetContainer.schema?.properties ?? [];

  async function finish(): Promise<void> {
    const finalRefusal = validateDraft(draft, existingProperties);
    if (finalRefusal !== null) {
      setError(finalRefusal);
      return;
    }
    setSaving(true);
    setError(null);
    if (itemId !== undefined) {
      const namedDraft = { ...draft, view: { ...draft.view, name: draft.title.trim() } };
      const reason =
        viewId === undefined
          ? await targetContainer.appendViewSetup(
              namedDraft.properties,
              compiledViews(namedDraft),
              true,
              namedDraft.publish && namedDraft.view.kind === 'interactive_form'
                ? namedDraft.view.id
                : null,
            )
          : await targetContainer.replaceViewSetup(
              viewId,
              namedDraft.properties,
              compiledViews(namedDraft),
              namedDraft.publish && namedDraft.view.kind === 'interactive_form'
                ? namedDraft.view.id
                : null,
            );
      setSaving(false);
      if (reason !== null) {
        setError(reason);
        return;
      }
      browserSessionStorage()?.removeItem(draftKey(recipe ?? FALLBACK_RECIPE, draftScope));
      const next = new URLSearchParams({ item: itemId, view: draft.view.id });
      void navigate(`/w/${workspaceId}?${next.toString()}`);
      return;
    }

    const result = await tree.createStructured({
      parentId,
      title: draft.title.trim(),
      properties: draft.properties,
      views: compiledViews(draft),
      defaultView: draft.view.id,
      publishInteractiveFormViewId:
        draft.publish && draft.view.kind === 'interactive_form' ? draft.view.id : null,
    });
    setSaving(false);
    if (result.id === null) {
      setError(result.refusal);
      return;
    }
    browserSessionStorage()?.removeItem(draftKey(recipe ?? FALLBACK_RECIPE, draftScope));
    const next = new URLSearchParams({ item: result.id, view: draft.view.id });
    void navigate(`/w/${workspaceId}?${next.toString()}`);
  }

  return (
    <CreationStudioFrame
      recipe={recipe}
      itemId={itemId}
      viewId={viewId}
      destination={destination}
      intent={intent}
      step={step}
      draft={draft}
      existingProperties={existingProperties}
      previewing={previewing}
      saving={saving}
      error={error}
      discarding={discarding}
      onStepChange={setStep}
      onError={setError}
      onPreviewToggle={() => {
        setPreviewing((current) => !current);
      }}
      onCancel={() => {
        setDiscarding(true);
      }}
      onFinish={() => void finish()}
      onDiscardClose={() => {
        setDiscarding(false);
      }}
      onDiscard={() => {
        browserSessionStorage()?.removeItem(draftKey(recipe, draftScope));
        void navigate(-1);
      }}
    >
      {step === 0 ? (
        <BasicsStep recipe={recipe} draft={draft} onChange={setDraft} />
      ) : (
        <OptionsStep draft={draft} existingProperties={existingProperties} onChange={setDraft} />
      )}
    </CreationStudioFrame>
  );
}
