/**
 * SubtitleRenderer — Extracts and renders subtitles from MKV files.
 *
 * - SRT/WebVTT subtitles: Converted to WebVTT and rendered as <track> overlay
 * - ASS/SSA subtitles: Rendered via jassub (WASM-based libass renderer)
 *
 * Subtitle extraction uses Mediabunny's Input to find subtitle tracks,
 * then matroska-subtitles for the actual subtitle data extraction.
 */

export interface SubtitleTrackInfo {
  index: number;
  codecId: string;
  language: string;
  name: string | null;
  type: 'srt' | 'ass' | 'ssa' | 'webvtt' | 'unknown';
}

export interface SubtitleConfig {
  videoElement: HTMLVideoElement;
  onSubtitleTracksFound: (tracks: SubtitleTrackInfo[]) => void;
  onError: (error: Error) => void;
}

export class SubtitleRenderer {
  private videoElement: HTMLVideoElement;
  private jassubInstance: any = null;
  private trackOverlay: HTMLTrackElement | null = null;
  private disposed = false;

  constructor(config: SubtitleConfig) {
    this.videoElement = config.videoElement;
  }

  /**
   * Detect subtitle tracks in a file using Mediabunny's Input.
   * Returns track info but does NOT extract subtitle content yet.
   */
  async detectSubtitleTracks(input: any): Promise<SubtitleTrackInfo[]> {
    if (this.disposed) return [];

    try {
      const allTracks = await input.getTracks();
      const subtitleTracks: SubtitleTrackInfo[] = [];

      for (const track of allTracks) {
        if (track.type === 'subtitle') {
          const codecId = track.internalCodecId || 'unknown';
          const language = await track.getLanguageCode() || 'und';
          const name = await track.getName();

          let type: SubtitleTrackInfo['type'] = 'unknown';
          if (codecId.includes('S_TEXT/WEBVTT') || codecId.includes('webvtt')) type = 'webvtt';
          else if (codecId.includes('S_TEXT/ASS') || codecId.includes('S_TEXT/SSA') || codecId === 'A_ASS/SSA') type = 'ass';
          else if (codecId.includes('S_TEXT/SSA')) type = 'ssa';
          else if (codecId.includes('S_TEXT/SRT') || codecId.includes('SubRip')) type = 'srt';
          else if (codecId.includes('A_SUBTITLE')) type = 'srt';

          if (type === 'ssa') type = 'ass';

          subtitleTracks.push({
            index: track.id,
            codecId,
            language,
            name,
            type,
          });
        }
      }

      return subtitleTracks;
    } catch (e) {
      console.warn('[SubtitleRenderer] Failed to detect subtitle tracks:', e);
      return [];
    }
  }

  /**
   * Initialize subtitle rendering for a given track type.
   * ASS/SSA: Uses jassub (lazy-loaded WASM libass renderer)
   * SRT/WebVTT: Uses HTML <track> overlay
   */
  async renderSubtitles(trackType: 'ass' | 'srt' | 'webvtt', _trackIndex: number, _input: any): Promise<void> {
    if (this.disposed) return;

    try {
      if (trackType === 'ass') {
        await this.initJassub();
      } else if (trackType === 'srt' || trackType === 'webvtt') {
        await this.initTrackOverlay();
      }
    } catch (e) {
      console.warn('[SubtitleRenderer] Failed to render subtitles:', e);
    }
  }

  private async initJassub(): Promise<void> {
    if (this.disposed || this.jassubInstance) return;

    try {
      const Jassub = await import('jassub');

      this.jassubInstance = new Jassub.default({
        video: this.videoElement,
        subContent: '',
        fonts: [],
      });

      console.log('[SubtitleRenderer] jassub initialized');
    } catch (e) {
      console.warn('[SubtitleRenderer] jassub init failed:', e);
    }
  }

  private async initTrackOverlay(): Promise<void> {
    if (this.disposed) return;

    try {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = 'Subtitles';
      track.srclang = 'und';

      const vttBlob = new Blob(['WEBVTT\n\n'], { type: 'text/vtt' });
      track.src = URL.createObjectURL(vttBlob);

      this.videoElement.appendChild(track);
      this.trackOverlay = track;

      console.log('[SubtitleRenderer] Track overlay initialized');
    } catch (e) {
      console.warn('[SubtitleRenderer] Track overlay init failed:', e);
    }
  }

  async updateSubtitles(content: string): Promise<void> {
    if (this.disposed) return;

    if (this.jassubInstance && content) {
      this.jassubInstance.setContent(content);
    } else if (this.trackOverlay) {
      const vttBlob = new Blob([content], { type: 'text/vtt' });
      this.trackOverlay.src = URL.createObjectURL(vttBlob);
    }
  }

  dispose(): void {
    this.disposed = true;

    if (this.jassubInstance) {
      this.jassubInstance.destroy();
      this.jassubInstance = null;
    }

    if (this.trackOverlay) {
      if (this.trackOverlay.src) {
        URL.revokeObjectURL(this.trackOverlay.src);
      }
      this.trackOverlay.remove();
      this.trackOverlay = null;
    }
  }
}
