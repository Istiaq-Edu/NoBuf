import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface SpriteSheetData {
  dataUrl: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  intervalSeconds: number;
  totalFrames: number;
  totalDuration: number;
}

export interface SpriteFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'ts', 'mpg', 'mpeg', '3gp', 'ogv',
]);

function isVideoFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXTENSIONS.has(ext);
}

export function useSpriteSheet(messageId: number | null, activeFolderId: number | null, fileName?: string) {
  const [sprite, setSprite] = useState<SpriteSheetData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<number>(0);

  useEffect(() => {
    if (!messageId || (fileName && !isVideoFile(fileName))) {
      setSprite(null);
      setLoading(false);
      setError(null);
      return;
    }

    const genId = ++abortRef.current;
    setLoading(true);
    setError(null);

    invoke<{
      data_url: string;
      frame_width: number;
      frame_height: number;
      columns: number;
      interval_seconds: number;
      total_frames: number;
      total_duration: number;
    }>('cmd_generate_sprite_sheet', {
      messageId,
      folderId: activeFolderId,
    })
      .then((result) => {
        if (genId !== abortRef.current) return; // stale
        setSprite({
          dataUrl: result.data_url,
          frameWidth: result.frame_width,
          frameHeight: result.frame_height,
          columns: result.columns,
          intervalSeconds: result.interval_seconds,
          totalFrames: result.total_frames,
          totalDuration: result.total_duration,
        });
        setLoading(false);
      })
      .catch((err) => {
        if (genId !== abortRef.current) return;
        console.warn('[useSpriteSheet] Generation failed:', err);
        setError(typeof err === 'string' ? err : 'Failed to generate sprite sheet');
        setLoading(false);
      });

    return () => {
      // Invalidate any in-flight request on cleanup
      abortRef.current++;
    };
  }, [messageId, activeFolderId]);

  const getFrameAt = useCallback(
    (timeSeconds: number): SpriteFrame | null => {
      if (!sprite) return null;
      const frameIndex = Math.min(
        Math.floor(timeSeconds / sprite.intervalSeconds),
        sprite.totalFrames - 1
      );
      if (frameIndex < 0) return null;

      const col = frameIndex % sprite.columns;
      const row = Math.floor(frameIndex / sprite.columns);

      return {
        x: col * sprite.frameWidth,
        y: row * sprite.frameHeight,
        width: sprite.frameWidth,
        height: sprite.frameHeight,
      };
    },
    [sprite]
  );

  return { sprite, loading, error, getFrameAt };
}
