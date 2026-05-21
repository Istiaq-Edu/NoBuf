import { createContext, useContext, useState, ReactNode, useCallback } from 'react';

interface CacheEntry {
    percentage: number;
    filename: string;
}

interface CacheSessionContextType {
    registerCache: (messageId: number, percentage: number, filename: string) => void;
    removeCache: (messageId: number) => void;
    getCacheInfo: (messageId: number) => CacheEntry | null;
    updateCachePercent: (messageId: number, percentage: number) => void;
    clearAll: () => void;
}

const CacheSessionContext = createContext<CacheSessionContextType | undefined>(undefined);

export function CacheSessionProvider({ children }: { children: ReactNode }) {
    const [cacheMap, setCacheMap] = useState<Map<number, CacheEntry>>(new Map());

    const registerCache = useCallback((messageId: number, percentage: number, filename: string) => {
        // console.log(`[CACHE-SESSION] registerCache: msg=${messageId} percent=${percentage}% file="${filename}"`);
        setCacheMap(prev => {
            const next = new Map(prev);
            next.set(messageId, { percentage, filename });
            return next;
        });
    }, []);

    const removeCache = useCallback((messageId: number) => {
        // console.log(`[CACHE-SESSION] removeCache: msg=${messageId}`);
        setCacheMap(prev => {
            const next = new Map(prev);
            next.delete(messageId);
            return next;
        });
    }, []);

    const getCacheInfo = useCallback((messageId: number): CacheEntry | null => {
        return cacheMap.get(messageId) ?? null;
    }, [cacheMap]);

    const updateCachePercent = useCallback((messageId: number, percentage: number) => {
        // console.log(`[CACHE-SESSION] updateCachePercent: msg=${messageId} percent=${percentage}%`);
        setCacheMap(prev => {
            const next = new Map(prev);
            const entry = next.get(messageId);
            if (entry) {
                next.set(messageId, { ...entry, percentage });
            }
            return next;
        });
    }, []);

    const clearAll = useCallback(() => {
        // console.log(`[CACHE-SESSION] clearAll`);
        setCacheMap(new Map());
    }, []);

    return (
        <CacheSessionContext.Provider value={{ registerCache, removeCache, getCacheInfo, updateCachePercent, clearAll }}>
            {children}
        </CacheSessionContext.Provider>
    );
}

export const useCacheSession = () => {
    const context = useContext(CacheSessionContext);
    if (!context) throw new Error('useCacheSession must be used within a CacheSessionProvider');
    return context;
};
