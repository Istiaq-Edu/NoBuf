export const AnalyzerEvents = {
  PROGRESS: 'progress',
  COMPLETE: 'complete',
  ERROR: 'error',
} as const;

export type AnalyzerEvent = (typeof AnalyzerEvents)[keyof typeof AnalyzerEvents];
