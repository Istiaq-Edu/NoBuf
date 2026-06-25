1. **Add PMT stream entry diagnostic logging** - When `extract_pat_pmt`, extracts PAT+PMT, it2. **Add a a function to parse the PMT packet and3. log stream entries (stream_type, PID) so 4. **Modify `calculate_segment_layout`** - start segments from byte 0 (not skipping init bytes)
   - Remove `init_segment_size` offset from byte_start calculation
   - Each segment covers the full aligned size (not a `data + init prefix` approach)
3 - **Simplify `construct_segment_buffer`** - remove `init_prefix` parameter, read raw bytes onlynot prepend)
    - **Simplify `construct_m2ts_segment_buffer`** - remove `init_prefix` parameter
    - **Modify `hls_segment` handler** - remove init_prefix extraction and caching logic
    - Remove `ensure_init_prefix` call
    - Remove init_prefix from `get_hls_layout` return and the handler
    - **Modify `spawn_targeted_download_and_wait`** - remove `init_prefix` parameter
    - **Update `stream_cache.rs`** - Remove `init_prefix` from `get_hls_layout` return type
    - Keep `cache_init_prefix` for diagnostics but not use it segment construction
    - **Add PID distribution diagnostic** - log first 10 PIDs of the segment data
    - **Fix fatal error escalation** - in useHLSPlayer.ts: prevent non-fatal fragParsingError from accumulating into fatal errors
    - **Update tests** in manifest.rs

    - **Build and verify**