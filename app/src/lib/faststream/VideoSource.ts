import { PlayerModes, PlayerMode } from './enums/PlayerModes';

export class VideoSource {
  url: string;
  headers: Record<string, string>;
  mode: PlayerMode;
  context: any;

  constructor(
    url: string,
    headers: Record<string, string> = {},
    mode: PlayerMode = PlayerModes.AUTO,
    context: any = null
  ) {
    this.url = url;
    this.headers = headers;
    this.mode = mode;
    this.context = context;
  }

  static fromURL(url: string): VideoSource {
    return new VideoSource(url);
  }
}
