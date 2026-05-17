declare module 'mp4box' {
  interface MP4BoxSample {
    dts: number;
    cts: number;
    duration: number;
    size: number;
    offset: number;
    is_sync: boolean;
    description?: any;
  }

  interface MP4BoxTrak {
    samples: MP4BoxSample[];
  }

  interface MP4BoxMoov {
    traks: MP4BoxTrak[];
  }

  interface MP4BoxFile {
    appendBuffer(buffer: ArrayBuffer & { fileStart: number }): void;
    onReady: (info: MP4Info) => void;
    onError: (e: any) => void;
    start(): void;
    stop(): void;
    flush(): void;
    moov?: MP4BoxMoov;
  }

  interface MP4Info {
    duration: number;
    timescale: number;
    videoTracks: MP4Track[];
    audioTracks: MP4Track[];
  }

  interface MP4Track {
    id: number;
    codec: string;
    width?: number;
    height?: number;
    duration: number;
    timescale: number;
  }

  function createFile(keepMoov?: boolean): MP4BoxFile;

  export { createFile, MP4BoxFile, MP4Info, MP4Track };
}
