declare module 'mux.js' {
  const muxjs: {
    mp4: {
      Transmuxer: new (options?: {
        baseMediaDecodeTime?: number;
        keepOriginalTimestamps?: boolean;
        remux?: boolean;
      }) => {
        on(event: 'data', callback: (segment: {
          initSegment?: Uint8Array;
          data?: Uint8Array;
          captions?: any[];
          metadata?: any[];
          videoTimingInfo?: { start: { pts: number; dts: number }; end: { pts: number; dts: number } };
          audioTimingInfo?: { start: { pts: number; dts: number }; end: { pts: number; dts: number } };
        }) => void): void;
        on(event: 'done', callback: () => void): void;
        on(event: 'trackinfo', callback: (info: { hasAudio: boolean; hasVideo: boolean }) => void): void;
        on(event: string, callback: (...args: any[]) => void): void;
        off(event: string, callback?: (...args: any[]) => void): void;
        push(data: Uint8Array): void;
        flush(): void;
        reset(): void;
        setBaseMediaDecodeTime(time: number): void;
      };
      tools: {
        inspect(data: Uint8Array): Array<{
          type: string;
          size?: number;
          boxes?: any[];
          avcData?: string;
          audioObjectType?: number;
          [key: string]: any;
        }>;
      };
      generator: {
        initSegment(tracks: any[], duration?: number): Uint8Array;
      };
    };
    mp2t: {
      tools: {
        parsePat(packet: Uint8Array): number;
        parsePmt(packet: Uint8Array): Record<number, number>;
      };
    };
  };
  export default muxjs;
}
