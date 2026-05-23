import { useState } from 'react';
import { HardDrive, Folder, Plus, RefreshCw, LogOut, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { SidebarItem } from './SidebarItem';
import { BandwidthWidget } from './BandwidthWidget';
import { TelegramFolder, BandwidthStats } from '../../types';

interface SidebarProps {
    folders: TelegramFolder[];
    activeFolderId: number | null;
    setActiveFolderId: (id: number | null) => void;
    onDrop: (e: React.DragEvent, folderId: number | null) => void;
    onDelete: (id: number, name: string) => void;
    onCreate: (name: string) => Promise<void>;
    isSyncing: boolean;
    isConnected: boolean;
    onSync: () => void;
    onLogout: () => void;
    bandwidth: BandwidthStats | null;
    collapsed: boolean;
    onToggleCollapse: () => void;
}

export function Sidebar({
    folders, activeFolderId, setActiveFolderId, onDrop, onDelete, onCreate,
    isSyncing, isConnected, onSync, onLogout, bandwidth, collapsed, onToggleCollapse
}: SidebarProps) {
    const [showNewFolderInput, setShowNewFolderInput] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");

    const submitCreate = async () => {
        if (!newFolderName.trim()) return;
        try {
            await onCreate(newFolderName);
            setNewFolderName("");
            setShowNewFolderInput(false);
        } catch {
            // handled by parent
        }
    }

    return (
        <aside className={`${collapsed ? 'w-16' : 'w-64'} bg-nobuf-surface border-r border-nobuf-border flex flex-col transition-[width] duration-200 ease-in-out shrink-0`} onClick={e => e.stopPropagation()}>

            {/* Toggle button — always in the same spot */}
            <div className="p-3 flex items-center">
                <button
                    onClick={onToggleCollapse}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-nobuf-subtext hover:text-nobuf-text hover:bg-nobuf-hover transition-colors"
                    title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                    {collapsed
                        ? <PanelLeftOpen className="w-4 h-4" />
                        : <PanelLeftClose className="w-4 h-4" />
                    }
                </button>
            </div>

            {/* Scrollable folder list */}
            <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto min-h-0">
                <SidebarItem
                    icon={HardDrive}
                    label="Saved Messages"
                    active={activeFolderId === null}
                    onClick={() => setActiveFolderId(null)}
                    onDrop={(e: React.DragEvent) => onDrop(e, null)}
                    folderId={null}
                    collapsed={collapsed}
                />
                {folders.map(folder => (
                    <SidebarItem
                        key={folder.id}
                        icon={Folder}
                        label={folder.name}
                        active={activeFolderId === folder.id}
                        onClick={() => setActiveFolderId(folder.id)}
                        onDrop={(e: React.DragEvent) => onDrop(e, folder.id)}
                        onDelete={() => onDelete(folder.id, folder.name)}
                        folderId={folder.id}
                        collapsed={collapsed}
                    />
                ))}
            </nav>

            {/* Create Folder */}
            <div className="px-2 pb-2 border-b border-nobuf-border">
                {showNewFolderInput ? (
                    <div className="px-3 py-2">
                        <input
                            autoFocus
                            type="text"
                            className="w-full bg-white/10 rounded px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-nobuf-primary"
                            placeholder="Folder Name"
                            value={newFolderName}
                            onChange={e => setNewFolderName(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && submitCreate()}
                            onBlur={() => { if (!newFolderName) { setShowNewFolderInput(false); if (collapsed) onToggleCollapse(); } }}
                        />
                    </div>
                ) : (
                    <button
                        onClick={() => {
                            if (collapsed) { onToggleCollapse(); }
                            setShowNewFolderInput(true);
                        }}
                        className={`w-full flex items-center px-3 py-2 rounded-lg text-sm font-medium text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text transition-colors border border-dashed border-nobuf-border overflow-hidden ${collapsed ? 'justify-center' : 'gap-3'}`}
                        title="Create Folder"
                    >
                        <Plus className="w-4 h-4 shrink-0" />
                        <span className={`whitespace-nowrap transition-all duration-200 ${collapsed ? 'w-0 opacity-0' : 'opacity-100'}`}>Create Folder</span>
                    </button>
                )}
            </div>

            {/* Footer — single structure, text fades out */}
            <div className="p-3 border-t border-nobuf-border">
                <div className={`flex items-center text-nobuf-subtext text-xs mb-3 ${collapsed ? 'justify-center' : 'gap-2'}`}>
                    <div className={`w-2 h-2 rounded-full shrink-0 ${isConnected ? 'bg-nobuf-primary animate-pulse' : 'bg-red-500'}`}></div>
                    <span className={`whitespace-nowrap overflow-hidden transition-all duration-200 ${collapsed ? 'max-w-0 opacity-0' : 'max-w-[200px] opacity-100'}`}>
                        {isConnected ? 'Connected' : 'Disconnected'}
                    </span>
                </div>

                <div className={`flex ${collapsed ? 'flex-col items-center gap-2' : 'gap-2'}`}>
                    <button
                        onClick={onSync}
                        disabled={isSyncing}
                        className={`btn-shine flex items-center justify-center text-xs font-medium bg-nobuf-primary text-nobuf-county-green hover:bg-nobuf-primary/90 rounded-lg transition-all duration-200 ${collapsed ? 'w-10 h-10' : 'flex-1 px-3 py-2 gap-2'} ${isSyncing ? 'opacity-50 cursor-not-allowed' : ''}`}
                        title={isSyncing ? 'Syncing...' : 'Sync'}
                    >
                        <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isSyncing ? 'animate-spin' : ''}`} />
                        <span className={`whitespace-nowrap overflow-hidden transition-all duration-200 ${collapsed ? 'w-0 opacity-0' : 'opacity-100'}`}>
                            {isSyncing ? 'Syncing...' : 'Sync'}
                        </span>
                    </button>
                    <button
                        onClick={onLogout}
                        className={`btn-shine flex items-center justify-center text-xs font-medium bg-red-500 text-white hover:bg-red-600 rounded-lg transition-all duration-200 ${collapsed ? 'w-10 h-10' : 'flex-1 px-3 py-2 gap-2'}`}
                        title="Sign Out"
                    >
                        <LogOut className="w-3.5 h-3.5 shrink-0" />
                        <span className={`whitespace-nowrap overflow-hidden transition-all duration-200 ${collapsed ? 'w-0 opacity-0' : 'opacity-100'}`}>Logout</span>
                    </button>
                </div>

                {/* Bandwidth — fades out when collapsed */}
                <div className={`transition-all duration-200 overflow-hidden ${collapsed ? 'max-h-0 opacity-0 mt-0' : 'max-h-40 opacity-100 mt-3'}`}>
                    {bandwidth && <BandwidthWidget bandwidth={bandwidth} />}
                </div>
            </div>

        </aside>
    )
}
