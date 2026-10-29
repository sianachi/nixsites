import { createElement, type ComponentType, type ReactNode } from 'react';

export interface ProgramEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly workspaceId: string;
  readonly containerId: string | null;
  readonly label: string;
}

// The app supplies the OpenUI program editor and starter program, so the view editor needs no
// openui import.
let provided: {
  readonly editor: ComponentType<ProgramEditorProps>;
  readonly starterProgram: string;
} | null = null;

export function provideProgramEditor(
  editor: ComponentType<ProgramEditorProps>,
  starterProgram: string,
): void {
  provided = { editor, starterProgram };
}

/** What a new custom view starts with, or nothing before the app has provided it. */
export function starterProgram(): string {
  return provided?.starterProgram ?? '';
}

/** Renders the provided program editor, or nothing before the app has provided one. */
export function ProgramEditorSlot(props: ProgramEditorProps): ReactNode {
  return provided === null ? null : createElement(provided.editor, props);
}
