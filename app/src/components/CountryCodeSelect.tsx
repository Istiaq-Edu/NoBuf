import { useState, useRef, useEffect, useMemo } from "react";
import { ChevronDown, Search, Check } from "lucide-react";

interface Country {
    code: string;       // ISO 3166-1 alpha-2
    name: string;
    dialCode: string;   // e.g. "+1", "+44"
    flag: string;       // emoji flag
}

// Common countries sorted by likelihood of use.
// Users can search for any country by name or dial code.
const COUNTRIES: Country[] = [
    { code: "US", name: "United States", dialCode: "+1", flag: "🇺🇸" },
    { code: "GB", name: "United Kingdom", dialCode: "+44", flag: "🇬🇧" },
    { code: "IN", name: "India", dialCode: "+91", flag: "🇮🇳" },
    { code: "BD", name: "Bangladesh", dialCode: "+880", flag: "🇧🇩" },
    { code: "RU", name: "Russia", dialCode: "+7", flag: "🇷🇺" },
    { code: "DE", name: "Germany", dialCode: "+49", flag: "🇩🇪" },
    { code: "FR", name: "France", dialCode: "+33", flag: "🇫🇷" },
    { code: "BR", name: "Brazil", dialCode: "+55", flag: "🇧🇷" },
    { code: "ID", name: "Indonesia", dialCode: "+62", flag: "🇮🇩" },
    { code: "PK", name: "Pakistan", dialCode: "+92", flag: "🇵🇰" },
    { code: "NG", name: "Nigeria", dialCode: "+234", flag: "🇳🇬" },
    { code: "JP", name: "Japan", dialCode: "+81", flag: "🇯🇵" },
    { code: "KR", name: "South Korea", dialCode: "+82", flag: "🇰🇷" },
    { code: "CN", name: "China", dialCode: "+86", flag: "🇨🇳" },
    { code: "TR", name: "Turkey", dialCode: "+90", flag: "🇹🇷" },
    { code: "IT", name: "Italy", dialCode: "+39", flag: "🇮🇹" },
    { code: "ES", name: "Spain", dialCode: "+34", flag: "🇪🇸" },
    { code: "CA", name: "Canada", dialCode: "+1", flag: "🇨🇦" },
    { code: "AU", name: "Australia", dialCode: "+61", flag: "🇦🇺" },
    { code: "NL", name: "Netherlands", dialCode: "+31", flag: "🇳🇱" },
    { code: "SA", name: "Saudi Arabia", dialCode: "+966", flag: "🇸🇦" },
    { code: "AE", name: "United Arab Emirates", dialCode: "+971", flag: "🇦🇪" },
    { code: "EG", name: "Egypt", dialCode: "+20", flag: "🇪🇬" },
    { code: "IR", name: "Iran", dialCode: "+98", flag: "🇮🇷" },
    { code: "IQ", name: "Iraq", dialCode: "+964", flag: "🇮🇶" },
    { code: "MY", name: "Malaysia", dialCode: "+60", flag: "🇲🇾" },
    { code: "PH", name: "Philippines", dialCode: "+63", flag: "🇵🇭" },
    { code: "TH", name: "Thailand", dialCode: "+66", flag: "🇹🇭" },
    { code: "VN", name: "Vietnam", dialCode: "+84", flag: "🇻🇳" },
    { code: "SG", name: "Singapore", dialCode: "+65", flag: "🇸🇬" },
    { code: "PL", name: "Poland", dialCode: "+48", flag: "🇵🇱" },
    { code: "UA", name: "Ukraine", dialCode: "+380", flag: "🇺🇦" },
    { code: "MX", name: "Mexico", dialCode: "+52", flag: "🇲🇽" },
    { code: "AR", name: "Argentina", dialCode: "+54", flag: "🇦🇷" },
    { code: "CO", name: "Colombia", dialCode: "+57", flag: "🇨🇴" },
    { code: "ZA", name: "South Africa", dialCode: "+27", flag: "🇿🇦" },
    { code: "KE", name: "Kenya", dialCode: "+254", flag: "🇰🇪" },
    { code: "MA", name: "Morocco", dialCode: "+212", flag: "🇲🇦" },
    { code: "DZ", name: "Algeria", dialCode: "+213", flag: "🇩🇿" },
    { code: "SE", name: "Sweden", dialCode: "+46", flag: "🇸🇪" },
    { code: "NO", name: "Norway", dialCode: "+47", flag: "🇳🇴" },
    { code: "FI", name: "Finland", dialCode: "+358", flag: "🇫🇮" },
    { code: "DK", name: "Denmark", dialCode: "+45", flag: "🇩🇰" },
    { code: "BE", name: "Belgium", dialCode: "+32", flag: "🇧🇪" },
    { code: "AT", name: "Austria", dialCode: "+43", flag: "🇦🇹" },
    { code: "CH", name: "Switzerland", dialCode: "+41", flag: "🇨🇭" },
    { code: "PT", name: "Portugal", dialCode: "+351", flag: "🇵🇹" },
    { code: "GR", name: "Greece", dialCode: "+30", flag: "🇬🇷" },
    { code: "CZ", name: "Czech Republic", dialCode: "+420", flag: "🇨🇿" },
    { code: "RO", name: "Romania", dialCode: "+40", flag: "🇷🇴" },
    { code: "HU", name: "Hungary", dialCode: "+36", flag: "🇭🇺" },
    { code: "IL", name: "Israel", dialCode: "+972", flag: "🇮🇱" },
    { code: "KZ", name: "Kazakhstan", dialCode: "+7", flag: "🇰🇿" },
    { code: "UZ", name: "Uzbekistan", dialCode: "+998", flag: "🇺🇿" },
    { code: "AZ", name: "Azerbaijan", dialCode: "+994", flag: "🇦🇿" },
    { code: "GH", name: "Ghana", dialCode: "+233", flag: "🇬🇭" },
    { code: "TZ", name: "Tanzania", dialCode: "+255", flag: "🇹🇿" },
    { code: "UG", name: "Uganda", dialCode: "+256", flag: "🇺🇬" },
    { code: "ET", name: "Ethiopia", dialCode: "+251", flag: "🇪🇹" },
    { code: "NP", name: "Nepal", dialCode: "+977", flag: "🇳🇵" },
    { code: "LK", name: "Sri Lanka", dialCode: "+94", flag: "🇱🇰" },
    { code: "MM", name: "Myanmar", dialCode: "+95", flag: "🇲🇲" },
    { code: "KH", name: "Cambodia", dialCode: "+855", flag: "🇰🇭" },
    { code: "LY", name: "Libya", dialCode: "+218", flag: "🇱🇾" },
    { code: "TN", name: "Tunisia", dialCode: "+216", flag: "🇹🇳" },
    { code: "SY", name: "Syria", dialCode: "+963", flag: "🇸🇾" },
    { code: "JO", name: "Jordan", dialCode: "+962", flag: "🇯🇴" },
    { code: "LB", name: "Lebanon", dialCode: "+961", flag: "🇱🇧" },
    { code: "YE", name: "Yemen", dialCode: "+967", flag: "🇾🇪" },
    { code: "AF", name: "Afghanistan", dialCode: "+93", flag: "🇦🇫" },
];

// Deduplicate by dial code (keep first occurrence)
const UNIQUE_COUNTRIES = COUNTRIES.filter((c, i, arr) =>
    arr.findIndex(x => x.dialCode === c.dialCode && x.name === c.name) === i
);

/** Auto-detect user's country from browser locale / timezone */
function detectCountry(): Country {
    try {
        // Try timezone-based detection
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
        const tzMap: Record<string, string> = {
            "America/": "US", "Europe/London": "GB", "Asia/Dhaka": "BD",
            "Asia/Kolkata": "IN", "Asia/Tokyo": "JP", "Asia/Shanghai": "CN",
            "Asia/Tehran": "IR", "Asia/Riyadh": "SA", "Asia/Dubai": "AE",
            "Asia/Karachi": "PK", "Asia/Jakarta": "ID", "Asia/Seoul": "KR",
            "Asia/Bangkok": "TH", "Asia/Manila": "PH", "Asia/Singapore": "SG",
            "Europe/Berlin": "DE", "Europe/Paris": "FR", "Europe/Moscow": "RU",
            "Europe/Istanbul": "TR", "Europe/Madrid": "ES", "Europe/Rome": "IT",
            "Europe/Amsterdam": "NL", "Europe/Warsaw": "PL", "Europe/Kiev": "UA",
            "Australia/": "AU", "America/Toronto": "CA", "America/Sao_Paulo": "BR",
        };
        for (const [prefix, code] of Object.entries(tzMap)) {
            if (tz.startsWith(prefix) || tz === prefix) {
                const found = UNIQUE_COUNTRIES.find(c => c.code === code);
                if (found) return found;
            }
        }
        // Try locale-based detection
        const locale = navigator.language || "en-US";
        const localeParts = locale.split("-");
        if (localeParts.length > 1) {
            const localeCode = localeParts[1].toUpperCase();
            const found = UNIQUE_COUNTRIES.find(c => c.code === localeCode);
            if (found) return found;
        }
    } catch { /* fallback below */ }
    return UNIQUE_COUNTRIES[0]; // Default: US
}

interface CountryCodeSelectProps {
    value: Country;
    onChange: (country: Country) => void;
}

export function CountryCodeSelect({ value, onChange }: CountryCodeSelectProps) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [highlightIdx, setHighlightIdx] = useState(0);
    const ref = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

    // Close on outside click
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
                setSearch("");
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [open]);

    // Focus search on open
    useEffect(() => {
        if (open) {
            setTimeout(() => searchRef.current?.focus(), 50);
        }
    }, [open]);

    const filtered = useMemo(() => {
        const q = search.toLowerCase().trim();
        if (!q) return UNIQUE_COUNTRIES;
        return UNIQUE_COUNTRIES.filter(c =>
            c.name.toLowerCase().includes(q) ||
            c.dialCode.includes(q) ||
            c.code.toLowerCase().includes(q)
        );
    }, [search]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlightIdx(prev => Math.min(prev + 1, filtered.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlightIdx(prev => Math.max(prev - 1, 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (filtered[highlightIdx]) {
                onChange(filtered[highlightIdx]);
                setOpen(false);
                setSearch("");
            }
        } else if (e.key === "Escape") {
            setOpen(false);
            setSearch("");
        }
    };

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="glass-input rounded-xl px-3 py-4 flex items-center gap-2 text-nobuf-text hover:border-nobuf-primary transition-all min-w-[110px]"
            >
                <span className="text-xl">{value.flag}</span>
                <span className="text-sm font-medium">{value.dialCode}</span>
                <ChevronDown className="w-4 h-4 text-nobuf-subtext ml-auto" />
            </button>

            {open && (
                <div className="absolute z-50 top-full left-0 mt-2 w-72 max-h-80 rounded-xl glass-input overflow-hidden flex flex-col shadow-2xl">
                    <div className="p-2 border-b border-nobuf-border/50">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-nobuf-subtext" />
                            <input
                                ref={searchRef}
                                type="text"
                                value={search}
                                onChange={(e) => { setSearch(e.target.value); setHighlightIdx(0); }}
                                onKeyDown={handleKeyDown}
                                placeholder="Search country..."
                                className="w-full bg-transparent text-sm text-nobuf-text placeholder-nobuf-subtext/50 pl-9 pr-3 py-2 focus:outline-none"
                            />
                        </div>
                    </div>
                    <div className="overflow-y-auto flex-1 country-dropdown-scroll">
                        {filtered.length === 0 ? (
                            <div className="p-4 text-center text-sm text-nobuf-subtext">No countries found</div>
                        ) : (
                            filtered.map((c, i) => (
                                <button
                                    key={`${c.code}-${c.dialCode}-${i}`}
                                    type="button"
                                    onClick={() => { onChange(c); setOpen(false); setSearch(""); }}
                                    onMouseEnter={() => setHighlightIdx(i)}
                                    className={`w-full px-3 py-2.5 flex items-center gap-3 text-left transition-colors ${
                                        i === highlightIdx
                                            ? "bg-nobuf-primary/10"
                                            : "hover:bg-nobuf-hover/50"
                                    }`}
                                >
                                    <span className="text-lg shrink-0">{c.flag}</span>
                                    <span className="text-sm text-nobuf-text flex-1 truncate">{c.name}</span>
                                    <span className="text-sm text-nobuf-subtext font-mono">{c.dialCode}</span>
                                    {value.code === c.code && value.dialCode === c.dialCode && (
                                        <Check className="w-4 h-4 text-nobuf-primary shrink-0" />
                                    )}
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

/** Auto-detect country on mount */
export function useDetectedCountry(): [Country, (c: Country) => void] {
    const [country, setCountry] = useState<Country>(UNIQUE_COUNTRIES[0]);

    useEffect(() => {
        setCountry(detectCountry());
    }, []);

    return [country, setCountry];
}

export type { Country };
export { UNIQUE_COUNTRIES as COUNTRIES_LIST };
