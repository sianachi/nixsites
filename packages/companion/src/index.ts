export { createCompanionBodies } from './bodies.js';
export {
  defaultClock,
  defaultIds,
  type BodyEdit,
  type BodyEditPlan,
  type CompanionBodies,
  type CompanionClock,
  type CompanionFiles,
  type FileRead,
  type CompanionIds,
  type CompanionPorts,
} from './ports.js';
export {
  runWorkspaceTool,
  WorkspaceToolRefusal,
  type RunOptions,
  type WorkspaceToolOutcome,
} from './run.js';
export { READ_ONLY_OPERATIONS, workspaceToolSchema, type WorkspaceToolArgs } from './tool-args.js';
export { canApplyWithoutAsking, hasExternalLink } from './auto-apply.js';
export { loadPreviewContext, type PreviewContext } from './context.js';
export { prepareNoteScopedTool, type NoteToolScope } from './scope.js';
export { structureFingerprint, type StructureFingerprint } from './guards.js';
export { readStructure, type ReadStructureResult } from './structure/read-structure.js';
export { applyTemplate } from './templates/apply.js';
export { listTemplates } from './templates/list.js';
export { readTemplate } from './templates/read.js';
export { saveAsTemplate, readSourceTree } from './templates/save.js';
export { describeToolCall } from './preview.js';
export type { PreviewModel, PreviewNode } from '@nix/structure-spec';
export { planBuild } from './blueprint/plan.js';
export { createSandbox, findSandbox } from './blueprint/sandbox.js';

export { executeBuild, type BuildResult } from './blueprint/build.js';

export { readView } from './structure/read-view.js';
