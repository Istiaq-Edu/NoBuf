# mediabunny (vendored v1.45.4) — Audio Track Enumeration & Selection API

Source of truth: `app/node_modules/mediabunny/dist/mediabunny.d.ts` (package.json `"types": "./dist/modules/src/index.d.ts"`; `dist/mediabunny.d.ts` is the identical rollup — line numbers below refer to it). All quotes verbatim.

---

## 1. Enumerating audio tracks — `Input`

```ts
// mediabunny.d.ts:2106–2124 (class Input)
getTracks(query?: InputTrackQuery<InputTrack>): Promise<InputTrack[]>;
/** Returns the list of all audio tracks of this input file. An optional query can be provided. */
getAudioTracks(query?: InputTrackQuery<InputAudioTrack>): Promise<InputAudioTrack[]>;
/**
 * Returns the primary audio track of this input file, or null if there are no audio tracks.
 *
 * Multiple factors determine which track is considered primary, including its position in the file, disposition,
 * bitrate (higher bitrate is preferred), and if it can be paired with the primary video track.
 */
getPrimaryAudioTrack(query?: InputTrackQuery<InputAudioTrack>): Promise<InputAudioTrack | null>;
```

Optional query (filter/sort at enumeration time):

```ts
// mediabunny.d.ts:2465
export declare type InputTrackQuery<T extends InputTrack> = {
    filter?: (track: T) => MaybePromise<boolean>;
    sortBy?: (track: T) => MaybePromise<number | number[]>;
};
```

## 2. Per-track metadata

### `InputAudioTrack` (audio-specific surface)

```ts
// mediabunny.d.ts:2153
export declare class InputAudioTrack extends InputTrack {
    get type(): TrackType;
    /** The codec of the track's packets. */
    getCodec(): Promise<AudioCodec | null>;
    /** @deprecated Use getCodec */          get codec(): AudioCodec | null;
    hasOnlyKeyPackets(): Promise<boolean>;
    /** Returns the number of audio channels in the track. */
    getNumberOfChannels(): Promise<number>;
    /** @deprecated */                        get numberOfChannels(): number;
    /** Returns the track's audio sample rate in hertz. */
    getSampleRate(): Promise<number>;
    /** @deprecated */                        get sampleRate(): number;
    getDecoderConfig(): Promise<AudioDecoderConfig | null>;
    getCodecParameterString(): Promise<string | null>;
    canDecode(): Promise<boolean>;
    determinePacketType(packet: EncodedPacket): Promise<PacketType | null>;
}
```

### Inherited from `InputTrack` (identity, language, name, disposition)

```ts
// mediabunny.d.ts (abstract class InputTrack, ~2295–2365)
/** The unique ID of this track in the input file. */
get id(): number;
/** The 1-based index of this track among all tracks of the same type in the input file. ... */
get number(): number;
/**
 * Returns the ISO 639-2/T language code for this track. If the language is unknown, this resolves to `'und'`
 * (undetermined).
 */
getLanguageCode(): Promise<string>;
/** @deprecated */ get languageCode(): string;
/** Returns the user-defined name for this track. */
getName(): Promise<string | null>;
/** @deprecated */ get name(): string | null;
/** Returns the track's disposition, i.e. information about its intended usage. */
getDisposition(): Promise<TrackDisposition>;
getBitrate(): Promise<number | null>;
getAverageBitrate(): Promise<number | null>;
getInternalCodecId(): Promise<string | number | Uint8Array<ArrayBufferLike> | null>;
// "For MPEG-TS files, this resolves to the `streamType` value from the Program Map Table."
isAudioTrack(): this is InputAudioTrack;
```

```ts
// mediabunny.d.ts:4063
export declare type TrackDisposition = {
    /** Indicates that this track is eligible for automatic selection by a player. Multiple tracks can be default tracks. */
    default: boolean;
    /** Indicates that the track is the primary track among other tracks of its type. */
    primary: boolean;
    forced: boolean;
    original: boolean;
    commentary: boolean;
    hearingImpaired: boolean;
    visuallyImpaired: boolean;
};
```

So per audio track you get: `id`, `number`, `getLanguageCode()` (ISO 639-2/T, `'und'` fallback), `getName()`, `getCodec()` (`AudioCodec | null`), `getNumberOfChannels()`, `getSampleRate()`, `getDisposition()` (`default`/`primary`/`commentary`/…), plus bitrate and the raw container codec id (MPEG-TS stream_type).

## 3. Selecting a SPECIFIC audio track for a Conversion

**There is no `trackFilter`/`include` option.** Selection is done via the `audio` option of `ConversionOptions`: pass a **function** that receives each `InputAudioTrack` and return `{ discard: true }` for every track you don't want:

```ts
// mediabunny.d.ts:995 (ConversionOptions, relevant fields)
export declare type ConversionOptions = {
    /** The input file. */
    input: Input;
    /** The output file. */
    output: Output;
    /**
     * Defines which input tracks are used for conversion. Defaults to `'all'` unless the input is an HLS input, in
     * which case it defaults to `'primary'`.
     *
     * - `'all'`: All input tracks are eligible for conversion.
     * - `'primary'`: Only the primary video and audio track from the input are eligible for conversion.
     */
    tracks?: 'all' | 'primary';
    /**
     * Audio-specific options. When passing an object, the same options are applied to all audio tracks. When passing a
     * function, it will be invoked for each audio track and is expected to return or resolve to the options
     * for that specific track. The function is passed an instance of {@link InputAudioTrack} as well as a number `n`,
     * which is the 1-based index of the track in the list of all audio tracks. ...
     */
    audio?: ConversionAudioOptions | ConversionAudioOptions[] | ((track: InputAudioTrack, n: number) => MaybePromise<ConversionAudioOptions | ConversionAudioOptions[] | undefined>);
    // video?: ... (same shape with ConversionVideoOptions)
    // trim?: { start?: number; end?: number };
};
```

```ts
// mediabunny.d.ts:929 (ConversionAudioOptions, relevant fields)
export declare type ConversionAudioOptions = {
    /** If `true`, all audio tracks will be discarded and will not be present in the output. */
    discard?: boolean;
    numberOfChannels?: number;
    sampleRate?: number;
    codec?: AudioCodec;
    bitrate?: number | Quality;
    /** When `true`, audio will always be re-encoded instead of directly copying over the encoded samples. */
    forceTranscode?: boolean;
    // sampleFormat?, process?, group?, ...
};
```

**Recipe** (keep only track with id `wantedId`, stream-copy it):

```ts
const conversion = await Conversion.init({
  input, output,
  tracks: 'all',                       // must NOT be 'primary'
  audio: (track) => track.id === wantedId ? {} : { discard: true },
});
// verify: conversion.discardedTracks lists { track, reason: 'discarded_by_user', ... }
await conversion.execute();
```

Discard accountability is typed too:

```ts
// mediabunny.d.ts:1353–1376 (DiscardedTrack)
/** The track that was discarded. */
track: ...;
reason: 'discarded_by_user' | 'max_track_count_reached' | 'max_track_count_of_type_reached'
      | 'unknown_source_codec' | 'undecodable_source_codec' | 'no_encodable_target_codec';
trackOptions: ConversionVideoOptions | ConversionAudioOptions;
```

Note: `Conversion` does **not** always take the primary track — `tracks` defaults to `'all'` (except HLS inputs), and the per-track `audio` callback is the sanctioned selection mechanism. Caveat: single-audio output containers (e.g. MP4 doesn't hit this, but some do) may still discard extras with `'max_track_count_of_type_reached'` — check `conversion.discardedTracks` / `isValid`.

### Manual fallback (Output + packet pump)

If bypassing `Conversion`, the low-level path is `Output.addAudioTrack` fed by an `EncodedPacketSink` on the chosen `InputAudioTrack`:

```ts
// mediabunny.d.ts:3265 (class Output)
/** Adds an audio track to the output with the given source. Can only be called before the output is started. */
addAudioTrack(source: AudioSource, metadata?: AudioTrackMetadata): OutputAudioTrack;

// mediabunny.d.ts:484 + 523–530
export declare type AudioTrackMetadata = BaseTrackMetadata & {};
export declare type BaseTrackMetadata = {
    /** The three-letter, ISO 639-2/T language code specifying the language of this track. */
    languageCode?: string;
    /** A user-defined name for this track, like "English" or "Director Commentary". */
    name?: string;
    /** The track's disposition, i.e. information about its intended usage. */
    disposition?: Partial<TrackDisposition>;
};

// mediabunny.d.ts:1400 (stream-copy source)
export declare class EncodedAudioPacketSource extends AudioSource {
    constructor(codec: AudioCodec);
    add(packet: EncodedPacket, meta?: EncodedAudioChunkMetadata): Promise<void>;
}
```

i.e. `new EncodedAudioPacketSource(await track.getCodec())` → `output.addAudioTrack(src, { languageCode, name })` → iterate packets from `new EncodedPacketSink(track)` into `src.add(...)`.

## 4. mpegts.js (vendored) — NO audio track selection

- `src/demux/pat-pmt-pes.ts:37`: PMT holds exactly one PID per codec slot — `common_pids: { h264, h265, av1, adts_aac, loas_aac, opus, ac3, eac3, mp3 }` (each `number | undefined`) — one audio PID total, not a list.
- `src/demux/ts-demuxer.ts:779–794`: `let already_has_audio = pmt.common_pids.adts_aac || ... || pmt.common_pids.mp3;` then each `else if (stream_type === ... && !already_has_audio)` — the **first** audio ES in the PMT wins; all subsequent audio PIDs are silently ignored, and neither `MediaDataSource` config nor the player API exposes any audio-track selection.
- Conclusion: to play a non-first audio track through mpegts.js/MSE, the stream must be re-muxed upstream (mediabunny Conversion with per-track `discard`) so the desired track is the only/first audio in the TS/fMP4 fed to the player.
