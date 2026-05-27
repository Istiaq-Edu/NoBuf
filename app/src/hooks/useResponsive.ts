import { useState, useEffect } from 'react';

interface ResponsiveState {
    isMobile: boolean;
    isTablet: boolean;
    isDesktop: boolean;
}

const MOBILE_BREAKPOINT = 640;
const TABLET_BREAKPOINT = 1024;

export function useResponsive(): ResponsiveState {
    const [state, setState] = useState<ResponsiveState>(() => {
        if (typeof window === 'undefined') {
            return { isMobile: false, isTablet: false, isDesktop: true };
        }
        const width = window.innerWidth;
        return {
            isMobile: width < MOBILE_BREAKPOINT,
            isTablet: width >= MOBILE_BREAKPOINT && width < TABLET_BREAKPOINT,
            isDesktop: width >= TABLET_BREAKPOINT,
        };
    });

    useEffect(() => {
        const mobileQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
        const tabletQuery = window.matchMedia(`(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${TABLET_BREAKPOINT - 1}px)`);
        const desktopQuery = window.matchMedia(`(min-width: ${TABLET_BREAKPOINT}px)`);

        const update = () => {
            setState({
                isMobile: mobileQuery.matches,
                isTablet: tabletQuery.matches,
                isDesktop: desktopQuery.matches,
            });
        };

        // Set initial state from actual media queries
        update();

        // Listen for changes on each query
        mobileQuery.addEventListener('change', update);
        tabletQuery.addEventListener('change', update);
        desktopQuery.addEventListener('change', update);

        return () => {
            mobileQuery.removeEventListener('change', update);
            tabletQuery.removeEventListener('change', update);
            desktopQuery.removeEventListener('change', update);
        };
    }, []);

    return state;
}
