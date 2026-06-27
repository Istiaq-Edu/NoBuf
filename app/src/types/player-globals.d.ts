// Type declarations for NoBuf player global state on window object.
// These are used for cross-component state coordination in the streaming player.
// Previously accessed via (window as any).__nobuf_* — now typed for safety.

declare global {
  interface Window {
    __nobuf_userSeekInProgress?: boolean;
    __nobuf_bufferFullDetected?: boolean;
    __nobuf_removeInProgress?: boolean;
    __nobuf_evictionResumePending?: boolean;
    __nobuf_evictionResumeByte?: number;
    __nobuf_nuclearRecoveryInProgress?: boolean;
    __nobuf_nuclearGeneration?: number;
    __nobuf_ptsDuration?: number;
    __nobuf_durationIsEstimate?: boolean;
    __nobuf_estimateDuration?: number;
  }
}

export {};
