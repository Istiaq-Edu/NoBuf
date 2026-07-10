import { motion } from 'framer-motion';
import { UploadCloud, Ban } from 'lucide-react';

interface DragDropOverlayProps {
    variant?: 'accept' | 'reject';
    folderName?: string;
}

export function DragDropOverlay({ variant = 'accept', folderName }: DragDropOverlayProps) {
    const reject = variant === 'reject';
    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center pointer-events-none"
        >
            <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className={`glass bg-nobuf-surface border ${reject ? 'border-red-500/50' : 'border-nobuf-primary/50'} text-nobuf-text rounded-2xl p-8 flex flex-col items-center gap-4 shadow-2xl`}
            >
                <div className={`p-4 rounded-full ${reject ? 'bg-red-500/10' : 'bg-nobuf-primary/10'}`}>
                    {reject
                        ? <Ban className="w-12 h-12 text-red-400" />
                        : <UploadCloud className="w-12 h-12 text-nobuf-primary animate-bounce" />}
                </div>
                <div className="text-center">
                    {reject ? (
                        <>
                            <h3 className="text-xl font-bold text-nobuf-text">Can't upload here</h3>
                            <p className="text-nobuf-subtext text-sm mt-1">Switch to Saved Messages or a folder to upload.</p>
                        </>
                    ) : (
                        <>
                            <h3 className="text-xl font-bold text-nobuf-text">Drop files to upload</h3>
                            <p className="text-nobuf-subtext text-sm mt-1">
                                {folderName
                                    ? <>Files will be uploaded to <span className="text-nobuf-primary font-medium">{folderName}</span></>
                                    : 'Files will be uploaded to the current folder'}
                            </p>
                        </>
                    )}
                </div>
            </motion.div>
        </motion.div>
    );
}
