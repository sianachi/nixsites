import catalogUrl from '@nix/template-catalog/index.json?url';
import type { renderView } from '@nix/view-render';

/**
 * The templates Nix ships, carried by the web app itself so every workspace on every deployment
 * offers them with no install step. A built-in is not a row anywhere: its archive is imported into
 * a workspace the first time somebody there uses it, and from then on it is that workspace's own.
 */
export interface BuiltInTemplate {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly itemCount: number;
  readonly viewKinds: readonly string[];
  readonly preview: Pick<Parameters<typeof renderView>[0], 'view' | 'rows' | 'schema'> | null;
  /** The template archive, base64. */
  readonly archive: string;
}

let loading: Promise<readonly BuiltInTemplate[]> | null = null;

/** Fetched once and on demand: the archives are a couple of hundred kilobytes nobody else needs. */
export function loadBuiltInTemplates(): Promise<readonly BuiltInTemplate[]> {
  loading ??= fetch(catalogUrl)
    .then((response) => {
      if (!response.ok) throw new Error('The built-in templates could not be loaded.');
      return response.json() as Promise<readonly BuiltInTemplate[]>;
    })
    .catch((reason: unknown) => {
      loading = null;
      throw reason;
    });
  return loading;
}

export function builtInArchive(template: BuiltInTemplate): Blob {
  const bytes = Uint8Array.from(atob(template.archive), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: 'application/x-nix-template' });
}

/**
 * The built-ins a workspace does not hold yet.
 *
 * shortcut: matched by title, because a template summary carries no catalog key; a renamed copy
 * shows its built-in again. Compare keys once the list response includes them.
 */
export function missingBuiltIns(
  catalog: readonly BuiltInTemplate[],
  held: readonly { readonly title: string }[],
): readonly BuiltInTemplate[] {
  const titles = new Set(held.map((template) => template.title));
  return catalog.filter((template) => !titles.has(template.name));
}
