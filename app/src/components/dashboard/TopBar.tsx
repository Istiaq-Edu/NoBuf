import { LayoutGrid, Sun, Moon, Settings, ArrowLeftRight } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';

interface TopBarProps {
    currentFolderName: string;
    selectedIds: number[];
    onShowMoveModal: () => void;
    onBulkDownload: () => void;
    onBulkDelete: () => void;
    onSelectAll: () => void;
    viewMode: 'grid' | 'list';
    setViewMode: (mode: 'grid' | 'list') => void;
    searchTerm: string;
    onSearchChange: (term: string) => void;
    onSettingsClick: () => void;
    onToggleTransfers: () => void;
    showTransferPanel: boolean;
    uploadActiveCount?: number;
    uploadFinishedCount?: number;
    downloadActiveCount?: number;
    downloadFinishedCount?: number;
}

export function TopBar({
    currentFolderName, selectedIds, onShowMoveModal, onBulkDownload, onBulkDelete,
    onSelectAll, viewMode, setViewMode, searchTerm, onSearchChange, onSettingsClick,
    onToggleTransfers, showTransferPanel,
    uploadActiveCount = 0, uploadFinishedCount = 0,
    downloadActiveCount = 0, downloadFinishedCount = 0,
}: TopBarProps) {
    const { theme, toggleTheme } = useTheme();

    return (
        <header className="h-14 border-b border-nobuf-border flex items-center px-4 justify-between bg-nobuf-surface/80 backdrop-blur-md sticky top-0 z-10" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-4">
                <div className="flex items-center text-sm breadcrumbs text-nobuf-subtext select-none">
                    <span className="hover:text-nobuf-text cursor-pointer transition-colors">Start</span>
                    <span className="mx-2">/</span>
                    <span className="text-nobuf-text font-medium">{currentFolderName}</span>
                </div>
            </div>

            <div className="flex-1 max-w-md mx-4">
                <input
                    type="text"
                    placeholder="Search files..."
                    className="w-full bg-nobuf-hover border border-nobuf-border rounded-lg px-3 py-1.5 text-sm text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:border-nobuf-primary/50 transition-colors"
                    value={searchTerm}
                    onChange={(e) => onSearchChange(e.target.value)}
                />
            </div>

            <div className="flex items-center gap-2">
                {selectedIds.length > 0 && (
                    <div className="flex items-center gap-2 mr-4 animate-in fade-in slide-in-from-top-2">
                        <span className="text-xs text-nobuf-subtext mr-2">{selectedIds.length} Selected</span>
                        <button onClick={onSelectAll} className="px-3 py-1.5 bg-nobuf-hover hover:bg-nobuf-border rounded-md text-xs text-nobuf-text transition">Select All</button>
                        <button onClick={onShowMoveModal} className="px-3 py-1.5 bg-nobuf-primary/20 hover:bg-nobuf-primary/30 text-nobuf-primary rounded-md text-xs transition font-medium">Move to...</button>
                        <button onClick={onBulkDownload} className="px-3 py-1.5 bg-nobuf-hover hover:bg-nobuf-border rounded-md text-xs text-nobuf-text transition">Download Selected</button>
                        <button onClick={onBulkDelete} className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-md text-xs transition">Delete</button>
                    </div>
                )}

                <button
                    onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
                    className="p-2 hover:bg-nobuf-hover rounded-md text-nobuf-subtext hover:text-nobuf-text transition relative group"
                    title="Toggle Layout"
                >
                    <LayoutGrid className="w-5 h-5" />
                    <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-nobuf-surface border border-nobuf-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                        {viewMode === 'grid' ? 'Switch to List' : 'Switch to Grid'}
                    </span>
                </button>

                <div className="w-px h-6 bg-nobuf-border mx-1"></div>

                <button
                    onClick={onToggleTransfers}
                    className={`p-2 hover:bg-nobuf-hover rounded-md transition relative group ${showTransferPanel ? 'text-nobuf-primary bg-nobuf-primary/10' : 'text-nobuf-subtext hover:text-nobuf-text'}`}
                    title="Transfers"
                >
                    <ArrowLeftRight className="w-5 h-5" />
                    {/* Upload badge — top-left, blue */}
                    {(uploadActiveCount > 0 || (uploadActiveCount === 0 && uploadFinishedCount > 0)) && (
                        <span className={`absolute -top-2 -left-2 min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center text-[10px] text-white font-bold ${uploadActiveCount > 0 ? 'bg-nobuf-ocean-green animate-pulse' : 'bg-nobuf-ocean-green/70'}`}>
                            {uploadActiveCount > 0 ? (uploadActiveCount > 9 ? '9+' : uploadActiveCount) : (uploadFinishedCount > 9 ? '9+' : uploadFinishedCount)}
                        </span>
                    )}
                    {/* Download badge — top-right, green */}
                    {(downloadActiveCount > 0 || (downloadActiveCount === 0 && downloadFinishedCount > 0)) && (
                        <span className={`absolute -top-2 -right-2 min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center text-[10px] text-nobuf-county-green font-bold ${downloadActiveCount > 0 ? 'bg-nobuf-primary animate-pulse' : 'bg-nobuf-primary/70'}`}>
                            {downloadActiveCount > 0 ? (downloadActiveCount > 9 ? '9+' : downloadActiveCount) : (downloadFinishedCount > 9 ? '9+' : downloadFinishedCount)}
                        </span>
                    )}
                    <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-nobuf-surface border border-nobuf-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                        Transfers
                    </span>
                </button>

                <button
                    onClick={onSettingsClick}
                    className="p-2 hover:bg-nobuf-hover rounded-md text-nobuf-subtext hover:text-nobuf-text transition relative group"
                    title="Settings"
                >
                    <Settings className="w-5 h-5" />
                    <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-nobuf-surface border border-nobuf-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                        Settings
                    </span>
                </button>

                <button
                    onClick={toggleTheme}
                    className="p-2 hover:bg-nobuf-hover rounded-md text-nobuf-subtext hover:text-nobuf-text transition relative group"
                    title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                >
                    {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                    <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-nobuf-surface border border-nobuf-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                        {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
                    </span>
                </button>
            </div>
        </header>
    )
}
