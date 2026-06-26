import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, X, Globe } from 'lucide-react';

interface RemoteUploadModalProps {
    open: boolean;
    onClose: () => void;
    onSubmit: (url: string) => void;
}

export function RemoteUploadModal({ open, onClose, onSubmit }: RemoteUploadModalProps) {
    const [url, setUrl] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (url.trim()) {
            onSubmit(url.trim());
            setUrl('');
            onClose();
        }
    };

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
                    onClick={onClose}
                >
                    <motion.div
                        initial={{ scale: 0.95, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.95, opacity: 0 }}
                        className="bg-nobuf-surface border border-nobuf-border rounded-xl shadow-2xl p-6 w-full max-w-md"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-lg font-semibold text-nobuf-text flex items-center gap-2">
                                <Globe className="w-5 h-5 text-nobuf-primary" />
                                Remote Upload
                            </h2>
                            <button
                                onClick={onClose}
                                className="p-1 text-nobuf-subtext hover:text-nobuf-text transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <p className="text-sm text-nobuf-subtext mb-4">
                            Enter a direct download URL. The file will be downloaded and uploaded to your Telegram Drive.
                        </p>

                        <form onSubmit={handleSubmit}>
                            <input
                                type="url"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                placeholder="https://example.com/file.mp4"
                                autoFocus
                                className="w-full px-4 py-2.5 bg-nobuf-hover border border-nobuf-border rounded-lg text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:border-nobuf-primary transition-colors"
                            />
                            <div className="flex gap-3 mt-4">
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="flex-1 px-4 py-2 text-sm text-nobuf-subtext hover:text-nobuf-text border border-nobuf-border rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={!url.trim()}
                                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-nobuf-primary rounded-lg hover:bg-nobuf-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Upload className="w-4 h-4" />
                                    Upload
                                </button>
                            </div>
                        </form>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
