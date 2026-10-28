/**
 * Chart views without React: the model, the geometry and an SVG renderer.
 *
 * The web app draws its JSX charts from the model and geometry here; a published site draws
 * the same charts as SVG strings with {@link renderChartSvg}. One source for both is what keeps a
 * figure on a site identical to the one in the app.
 */

export * from './model.js';
export * from './geometry.js';
export { renderChartSvg, type ChartTable } from './svg.js';
export type { ChartInput } from './types.js';
