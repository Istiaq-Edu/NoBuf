# mp4box.js — audio track info & mid-playback audio-track re-segmentation

Source: vendored `app/node_modules/mp4box` — **v0.5.4** per `package.json` (task said 0.5.2; the vendored copy is 0.5.4). All quotes from `src/*.js`.

---

## 1. What `info.audioTracks` exposes per track

`getInfo()` (`src/isofile.js:300`) builds one `track` object per `trak` and pushes audio tracks into `movie.audioTracks`:

```js
movie.audioTracks = [];
...
track.id = trak.tkhd.track_id;
track.name = trak.mdia.hdlr.name;
...
track.codec = sample_desc.getCodec();
track.kind = (trak.udta && trak.udta.kinds.length ? trak.udta.kinds[0] : { schemeURI: "", value: ""});
track.language = (trak.mdia.elng ? trak.mdia.elng.extended_language : trak.mdia.mdhd.languageString);
track.nb_samples = trak.samples.length;
track.size = trak.samples_size;
track.bitrate = (track.size*8*track.timescale)/track.samples_duration;
if (sample_desc.isAudio()) {
    track.type = "audio";
    movie.audioTracks.push(track);
    track.audio = {};
    track.audio.sample_rate = sample_desc.getSampleRate();
    track.audio.channel_count = sample_desc.getChannelCount();
    track.audio.sample_size = sample_desc.getSampleSize();
}
```

So per audio track you get: `id`, `name` (hdlr name), `language` (`elng` extended language if present, else `mdhd` ISO-639 string), `codec` (RFC 6381 string via `getCodec()`), `kind`, `duration`/`timescale`/`movie_duration`, `nb_samples`, `size`, `bitrate`, `alternate_group`, `created`/`modified`, and `track.audio = { sample_rate, channel_count, sample_size }`. (`channel_count` comes from the stsd audio sample entry: `box-codecs.js:62 return this.channel_count;`.)

MIME building also uses it: `else if (movie.audioTracks && movie.audioTracks.length > 0) { movie.mime += 'audio/mp4; codecs="'; }` (isofile.js:405).

---

## 2. Switching the fragmented audio track mid-playback

### The API surface

`setSegmentOptions` (isofile.js:56) — registers a track for fragmentation and **rewinds its cursor to sample 0**:

```js
ISOFile.prototype.setSegmentOptions = function(id, user, options) {
    var trak = this.getTrackById(id);
    if (trak) {
        var fragTrack = {};
        this.fragmentedTracks.push(fragTrack);
        fragTrack.id = id;
        ...
        trak.nextSample = 0;
        fragTrack.segmentStream = null;
        fragTrack.nb_samples = 1000;
        ...
```

`unsetSegmentOptions` (isofile.js:75) — only splices the entry out of `fragmentedTracks`; it does **not** free anything or touch the trak:

```js
ISOFile.prototype.unsetSegmentOptions = function(id) {
    var index = -1;
    for (var i = 0; i < this.fragmentedTracks.length; i++) {
        var fragTrack = this.fragmentedTracks[i];
        if (fragTrack.id == id) { index = i; }
    }
    if (index > -1) { this.fragmentedTracks.splice(index, 1); }
}
```

`processSamples` (isofile.js:432) explicitly supports stopping a track's fragmentation mid-loop:

```js
fragTrak.segmentStream = null;
if (fragTrak !== this.fragmentedTracks[i]) {
    /* make sure we can stop fragmentation if needed */
    break;
}
```

`initializeSegmentation` (isofile-write.js:78) is guarded — `resetTables()` runs **only once** per file:

```js
if (!this.isFragmentationInitialized) {
    this.isFragmentationInitialized = true;
    this.nextMoofNumber = 0;
    this.resetTables();
}
initSegs = [];
for (i = 0; i < this.fragmentedTracks.length; i++) {
    ...
    seg.buffer = ISOFile.writeInitializationSegment(this.ftyp, moov, ...,
        (this.moov.traks[i].samples.length>0 ? this.moov.traks[i].samples[0].duration: 0));
```

`resetTables()` (isofile-sample-processing.js:8) zeroes the raw stbl boxes for **all** tracks (fragmented or not) — but this only affects box serialization for init segments; the in-memory `trak.samples[]` metadata array (built by `buildSampleLists`) is untouched:

```js
stco.chunk_offsets = [];
stsc.first_chunk = []; ...
stsz.sample_sizes = [];
stts.sample_counts = []; ...
```

Note the loop bug on a second call: `this.moov.traks[i]` indexes moov's trak list by the *fragmentedTracks* index `i` — if the new fragmented-track set doesn't align with trak order, the `sample_duration` default written into `trex` comes from the wrong track (cosmetic: it's only a default duration hint).

### Sample-release semantics — is the new track's data already consumed?

Sample **metadata** persists; sample **data** is lazy. `getSample` (isofile-sample-processing.js:496) allocates on demand and copies from whatever buffers are still appended:

```js
if (!sample.data) {
    /* Not yet fetched */
    sample.data = new Uint8Array(sample.size);
    sample.alreadyRead = 0;
    ...
var index = this.stream.findPosition(true, sample.offset + sample.alreadyRead, false);
if (index > -1) { ... DataStream.memcpy(...); buffer.usedBytes += ...; }
else { return null; }
```

But the underlying byte buffers ARE discarded as playback proceeds. Every `appendBuffer`/`flush` ends with:

```js
this.stream.cleanBuffers();          // isofile.js:294 / :568
// buffer.js:195
if (buffer.usedBytes === buffer.byteLength) {
    Log.debug("MultiBufferStream", "Removing buffer #"+i);
    this.buffers.splice(i, 1);
```

and `releaseSample` (isofile-sample-processing.js:566) nulls per-sample copies after `releaseUsedSamples`:

```js
this.samplesDataSize -= sample.size;
sample.data = null;
sample.alreadyRead = 0;
```

So bytes for the not-previously-fragmented audio track that lived in already-played regions are **gone**. However, that is a *recoverable* state by design: when `createFragment` can't get the sample it records where to fetch —

```js
var sample = this.getSample(trak, sampleNumber);
if (sample == null) {
    this.setNextSeekPositionFromSample(trak.samples[sampleNumber]);
    return null;
}
```

and `appendBuffer` returns that position as `nextFileStart`, so the app can re-download the needed byte range and re-append it (buffers can be appended at any `fileStart`; `findPosition(true, ...)` scans from the start of the buffer list).

### The real hazard: `seek()` is global

`seekTrack` (isofile.js:574) sets `trak.nextSample = seek_sample_num`, and `seek()` (isofile.js:628) iterates **all** `moov.traks` — not just the newly fragmented one:

```js
for (i = 0; i<moov.traks.length; i++) {
    trak = moov.traks[i];
    ...
    trak_seek_info = this.seekTrack(time, useRap, trak);
```

So `unsetSegmentOptions(oldAudio) + setSegmentOptions(newAudio) + seek(t)` **also rewinds the still-playing video track's `nextSample` to the RAP ≤ t**, causing the video fragmenter to re-emit segments the player already has. There is no per-track seek in the public API. Additionally `setSegmentOptions` forces `trak.nextSample = 0`, so without a `seek()` the new audio track segments from the beginning of the file.

---

## 3. Verdict

- **Mechanically possible in one instance**: `trak.samples` metadata survives; discarded mdat bytes are re-fetchable via the `nextFileStart` / `setNextSeekPositionFromSample` re-download loop; `unsetSegmentOptions` cleanly stops the old track; a second `initializeSegmentation()` returns an init segment for the new track (stbl already zeroed by the one-time `resetTables()`).
- **But it is not proven-safe**: `seek()` unavoidably resets `nextSample` on *every* track (video re-emits duplicate segments), `setSegmentOptions` rewinds the new track to sample 0, second-call `initializeSegmentation` has the `traks[i]` index-mismatch quirk, and none of this path is exercised by upstream demos (which fix the fragmented-track set before `initializeSegmentation`).
- **Recommendation**: for switching to a different audio track mid-playback, use a **fresh MP4Box instance** — re-append the moov bytes (already cached from the first parse; no network re-download needed if retained), `setSegmentOptions(newAudioTrackId)` only, `initializeSegmentation()`, `seek(currentTime)`, then feed byte ranges. This sidesteps all shared-cursor/global-seek state in the live video instance.
