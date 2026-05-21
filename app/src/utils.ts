export function formatBytes(bytes: number, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// ── File type classification ────────────────────────────────────────────

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'ts'] as const;
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'aac', 'flac', 'm4a', 'opus'] as const;
const MEDIA_EXTENSIONS: readonly string[] = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif'] as const;
const DOCUMENT_EXTENSIONS = ['pdf', 'doc', 'docx', 'txt', 'rtf', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'json', 'xml', 'md', 'odt', 'ods'] as const;

const endsWithAny = (name: string, exts: readonly string[]) => {
    const lower = name.toLowerCase();
    return exts.some(ext => lower.endsWith(ext));
};

export const isMediaFile   = (name: string) => endsWithAny(name, MEDIA_EXTENSIONS);
export const isVideoFile   = (name: string) => endsWithAny(name, VIDEO_EXTENSIONS);
export const isAudioFile   = (name: string) => endsWithAny(name, AUDIO_EXTENSIONS);
export const isImageFile   = (name: string) => endsWithAny(name, IMAGE_EXTENSIONS);
export const isDocumentFile = (name: string) => endsWithAny(name, DOCUMENT_EXTENSIONS);
export const isPdfFile     = (name: string) => name.toLowerCase().endsWith('.pdf');

export type FileCategory = 'videos' | 'audio' | 'images' | 'documents' | 'misc';

export function getFileCategory(name: string): FileCategory {
    if (isVideoFile(name)) return 'videos';
    if (isAudioFile(name)) return 'audio';
    if (isImageFile(name)) return 'images';
    if (isDocumentFile(name)) return 'documents';
    return 'misc';
}

export const ALL_FILE_CATEGORIES: FileCategory[] = ['videos', 'audio', 'images', 'documents', 'misc'];
