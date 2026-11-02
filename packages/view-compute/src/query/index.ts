import type { ViewCompute } from '../types';

/** Placeholder until this slice is ported; null means "needs a connection". */
export const computeQuery: ViewCompute = () => Promise.resolve(null);
