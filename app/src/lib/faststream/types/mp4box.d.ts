declare module 'mp4box' {
  interface MP4BoxFile {
    appendBuffer(buffer: ArrayBuffer & { fileStart: number }): void;
    onReady: (info: MP4Info) => void;
    onError: (e: any) => void;
    start(): void;
    stop(): void;
    flush(): void;
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
