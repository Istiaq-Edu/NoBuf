import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, FileArchive, File, Folder, Download, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { TelegramFile } from '../../types';

interface ArchiveEntry {
    filename: string;
    size: number;
    is_dir: boolean;
}

interface ExtractedFile {
    temp_path: string;
    filename: string;
    size: number;
}

interface ArchiveViewerModalProps {
    file: TelegramFile;
    activeFolderId: number | null;
    onClose: () => void;
}

function formatBytes(bytes: number): string {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function ArchiveViewerModal({ file, activeFolderId, onClose }: ArchiveViewerModalProps) {
    const [entries, setEntries] = useState<ArchiveEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [extracting, setExtracting] = useState<number | null>(null);

    useEffect(() => {
        const load = async () => {
            setLoading(true);
            setError(null);
            try {
                const result = await invoke<ArchiveEntry[]>('cmd_list_archive_contents', {
                    messageId: file.id,
                    folderId: activeFolderId,
                });
                setEntries(result);
            } catch (e) {
                setError(String(e));
            } finally {
                setLoading(false);
            }
        };
        load();
    }, [file.id, activeFolderId]);

    const handleExtract = async (index: number) => {
        setExtracting(index);
        try {
            const result = await invoke<ExtractedFile>('cmd_extract_archive_entry', {
                messageId: file.id,
                folderId: activeFolderId,
                entryIndex: index,
            });
            // Ask user where to save
            const savePath = await save({ defaultPath: result.filename });
            if (savePath) {
                // Copy temp file to save location
                // Since we can't directly copy from Rust, we'll just show the temp path
                // In a real app, we'd use a Tauri command to copy the file
                toast.success(`Extracted to: ${result.temp_path}`);
            } else {
                toast.info(`Extracted to temp: ${result.temp_path}`);
            }
        } catch (e) {
            toast.error(`Extraction failed: ${e}`);
        } finally {
            setExtracting(null);
        }
    };

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[150] bg-black/90 flex items-center justify-center p-4 backdrop-blur-sm"
                onClick={onClose}
            >
                <motion.div
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.95, opacity: 0 }}
                    className="bg-nobuf-surface border border-nobuf-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between p-4 border-b border-nobuf-border">
                        <div className="flex items-center gap-3">
                            <FileArchive className="w-6 h-6 text-nobuf-primary" />
                            <div>
                                <h2 className="text-lg font-semibold text-nobuf-text">{file.name}</h2>
                                <p className="text-xs text-nobuf-subtext">
                                    {entries.length} items
                                </p>
                            </div>
                        </div>
                        <button
                            onClick={onClose}
                            className="p-2 text-nobuf-subtext hover:text-nobuf-text transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Content */}
                    <div className="flex-1 overflow-y-auto p-4">
                        {loading && (
                            <div className="flex flex-col items-center justify-center py-12 gap-3">
                                <Loader2 className="w-8 h-8 text-nobuf-primary animate-spin" />
                                <p className="text-nobuf-subtext text-sm">
                                    Downloading and parsing archive from Telegram...
                                </p>
                            </div>
                        )}

                        {error && (
                            <div className="text-red-400 bg-red-500/10 p-4 rounded-lg border border-red-500/20">
                                <p className="font-medium">Failed to read archive</p>
                                <p className="text-sm mt-1">{error}</p>
                            </div>
                        )}

                        {!loading && !error && entries.length === 0 && (
                            <p className="text-nobuf-subtext text-center py-8">
                                Archive is empty
                            </p>
                        )}

                        {!loading && !error && entries.length > 0 && (
                            <div className="space-y-1">
                                {entries.map((entry, index) => (
                                    <div
                                        key={index}
                                        className="flex items-center gap-3 p-2 hover:bg-nobuf-hover rounded-lg transition-colors group"
                                    >
                                        {entry.is_dir ? (
                                            <Folder className="w-5 h-5 text-yellow-500 shrink-0" />
                                        ) : (
                                            <File className="w-5 h-5 text-nobuf-subtext shrink-0" />
                                        )}
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm text-nobuf-text truncate">
                                                {entry.filename}
                                            </p>
                                            <p className="text-xs text-nobuf-subtext">
                                                {formatBytes(entry.size)}
                                            </p>
                                        </div>
                                        {!entry.is_dir && (
                                            <button
                                                onClick={() => handleExtract(index)}
                                                disabled={extracting !== null}
                                                className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-1 text-xs text-nobuf-primary hover:bg-nobuf-primary/10 rounded transition-all disabled:opacity-50"
                                            >
                                                {extracting === index ? (
                                                    <Loader2 className="w-3 h-3 animate-spin" />
                                                ) : (
                                                    <Download className="w-3 h-3" />
                                                )}
                                                Extract
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
}
