import type { RenderRequest, RenderedView } from './types.js';
import {
  drawBoard,
  drawChart,
  drawChat,
  drawCalendar,
  drawChecklist,
  drawDrive,
  drawForm,
  drawGallery,
  drawHabitGrid,
  drawInteractiveForm,
  drawList,
  drawMatrix,
  drawOutline,
  drawQuery,
  drawSheet,
  drawTimeline,
  type Drawing,
} from './kinds.js';
import { document } from './svg.js';

function drawHabitTracker(request: RenderRequest): Drawing {
  const drawing = drawHabitGrid(request);
  return {
    ...drawing,
    notes: [
      'A habit tracker is exported as its item list; check-in history and the interactive progress grid are not included.',
      ...drawing.notes,
    ],
  };
}

/**
 * A view, drawn.
 *
 * **A closed set with an honest default.** `ViewSnapshot.kind` is a string off the wire, so a view
 * kind a newer build stored is a real possibility; it draws as a list, which is the kind every other
 * view is a rearrangement of, and the caller is told that is what happened. Refusing would put a
 * hole in the export where an item's own view was.
 */

const DRAWERS: Readonly<Record<string, (request: RenderRequest) => Drawing>> = {
  list: drawList,
  chat: drawChat,
  board: drawBoard,
  gallery: drawGallery,
  calendar: drawCalendar,
  timeline: drawTimeline,
  sheet: drawSheet,
  form: drawForm,
  interactive_form: drawInteractiveForm,
  query: drawQuery,
  habit_tracker: drawHabitTracker,
  matrix: drawMatrix,
  chart: drawChart,
  checklist: drawChecklist,
  outline: drawOutline,
  drive: drawDrive,
};

export const DRAWN_VIEW_KINDS: readonly string[] = Object.keys(DRAWERS);

export function renderView(request: RenderRequest): RenderedView {
  const drawer = DRAWERS[request.view.kind];

  const unknown =
    drawer === undefined
      ? [`A "${request.view.kind}" view was drawn as a list, because this version cannot draw one.`]
      : [];

  const drawing = (drawer ?? drawList)(request);

  // A view with nothing in it still draws its frame: an empty board is a fact about the workspace,
  // and a blank space would read as the export having failed to include something.
  const height = Math.max(drawing.height, 24);

  return {
    svg: document(request.width, height, drawing.body),
    width: request.width,
    height,
    notes: [...unknown, ...drawing.notes],
  };
}
