use crate::ts_demux::{VideoCodec, VideoCodecConfig, AudioCodecConfig, PesFrame, annex_b_to_length_prefixed, PTS_CLOCK_RATE};

pub struct Fmp4InitSegment {
    pub data: Vec<u8>,
    pub video_codec_string: String,
    pub audio_codec_string: String,
    pub mime_type: String,
    pub video_track_id: u32,
    pub audio_track_id: u32,
    pub timescale: u32,
}

pub struct Fmp4MediaSegment {
    pub data: Vec<u8>,
    pub video_samples: u32,
    pub audio_samples: u32,
    pub start_time_s: f64,
    pub duration_s: f64,
}

pub fn build_init_segment(
    video: &VideoCodecConfig,
    audio: &AudioCodecConfig,
) -> Fmp4InitSegment {
    let timescale = 90000u32;
    let video_track_id: u32 = 1;
    let audio_track_id: u32 = 2;

    let video_codec_string = match video.codec {
        VideoCodec::Avc => {
            let profile = video.sps.get(1).copied().unwrap_or(66);
            let constraint_flags = video.sps.get(2).copied().unwrap_or(0xC0);
            let level = video.sps.get(3).copied().unwrap_or(30);
            format!("avc1.{:02X}{:02X}{:02X}", profile, constraint_flags, level)
        }
        VideoCodec::Hevc => {
            format!("hvc1.1.6.L{}.B0", video.sps.get(3).copied().unwrap_or(93) >> 1)
        }
    };

    let audio_object_type = if audio.audio_object_type == 5 || audio.audio_object_type == 29 {
        5
    } else {
        2
    };
    let audio_codec_string = format!("mp4a.40.{}", audio_object_type);
    let mime_type = format!("video/mp4; codecs=\"{}, {}\"", video_codec_string, audio_codec_string);

    let mut buf = Vec::with_capacity(4096);

    write_box(&mut buf, b"ftyp", |b| {
        b.extend_from_slice(b"iso5");
        b.extend_from_slice(&0x200u32.to_be_bytes());
        b.extend_from_slice(b"iso5");
        b.extend_from_slice(b"iso6");
        b.extend_from_slice(b"mp41");
    });

    write_box(&mut buf, b"moov", |moov_buf| {
        write_mvhd(moov_buf, timescale);

        write_box(moov_buf, b"trak", |trak_buf| {
            write_tkhd(trak_buf, video_track_id, video.width, video.height, false);
            write_box(trak_buf, b"mdia", |mdia_buf| {
                write_mdhd(mdia_buf, timescale);
                write_hdlr(mdia_buf, b"vide", b"VideoHandler");
                write_box(mdia_buf, b"minf", |minf_buf| {
                    write_vmhd(minf_buf);
                    write_dinf(minf_buf);
                    write_video_stbl(minf_buf, video);
                });
            });
        });

        write_box(moov_buf, b"trak", |trak_buf| {
            write_tkhd(trak_buf, audio_track_id, 0, 0, true);
            write_box(trak_buf, b"mdia", |mdia_buf| {
                let audio_timescale = audio.sampling_freq;
                write_mdhd(mdia_buf, audio_timescale);
                write_hdlr(mdia_buf, b"soun", b"SoundHandler");
                write_box(mdia_buf, b"minf", |minf_buf| {
                    write_smhd(minf_buf);
                    write_dinf(minf_buf);
                    write_audio_stbl(minf_buf, audio, audio_timescale);
                });
            });
        });

        write_box(moov_buf, b"mvex", |mvex_buf| {
            write_trex(mvex_buf, video_track_id);
            write_trex(mvex_buf, audio_track_id);
        });
    });

    Fmp4InitSegment {
        data: buf,
        video_codec_string,
        audio_codec_string,
        mime_type,
        video_track_id,
        audio_track_id,
        timescale,
    }
}

pub fn build_media_segment(
    frames: &[PesFrame],
    video_track_id: u32,
    audio_track_id: u32,
    video_timescale: u32,
    audio_timescale: u32,
    segment_sequence: u32,
) -> Option<Fmp4MediaSegment> {
    let mut video_samples: Vec<SampleInfo> = Vec::new();
    let mut audio_samples: Vec<SampleInfo> = Vec::new();
    let mut video_data = Vec::new();
    let mut audio_data = Vec::new();
    let mut start_pts_s: Option<f64> = None;
    let mut end_pts_s: f64 = 0.0;

    let mut video_dts_list: Vec<i64> = Vec::new();
    let mut audio_dts_list: Vec<i64> = Vec::new();

    for frame in frames {
        let pts_s = frame.pts as f64 / PTS_CLOCK_RATE as f64;
        if start_pts_s.is_none() { start_pts_s = Some(pts_s); }
        end_pts_s = pts_s;

        let is_video = frame.stream_type == 0x1b || frame.stream_type == 0x24;

        if is_video {
            let lp_data = annex_b_to_length_prefixed(&frame.data);
            let size = lp_data.len() as u32;

            let dts_timescale = if frame.has_dts {
                (frame.dts * video_timescale as u64 / PTS_CLOCK_RATE) as i64
            } else {
                (frame.pts * video_timescale as u64 / PTS_CLOCK_RATE) as i64
            };

            let cts = ((frame.pts as i64 - if frame.has_dts { frame.dts as i64 } else { frame.pts as i64 })
                * video_timescale as i64 / PTS_CLOCK_RATE as i64) as i32;

            video_dts_list.push(dts_timescale);
            video_samples.push(SampleInfo {
                duration: 0,
                size,
                dts: dts_timescale,
                is_sync: frame.is_keyframe,
                cts,
            });
            video_data.extend_from_slice(&lp_data);
        } else {
            let size = frame.data.len() as u32;
            let dts_timescale = (frame.pts * audio_timescale as u64 / PTS_CLOCK_RATE) as i64;

            audio_dts_list.push(dts_timescale);
            audio_samples.push(SampleInfo {
                duration: 0,
                size,
                dts: dts_timescale,
                is_sync: true,
                cts: 0,
            });
            audio_data.extend_from_slice(&frame.data);
        }
    }

    for i in 0..video_samples.len() {
        if i + 1 < video_dts_list.len() {
            let dur = video_dts_list[i + 1] - video_dts_list[i];
            video_samples[i].duration = dur.max(1) as u32;
        } else if video_samples.len() > 1 {
            video_samples[i].duration = video_samples[i.saturating_sub(1)].duration;
        } else {
            video_samples[i].duration = 3003;
        }
    }

    for i in 0..audio_samples.len() {
        if i + 1 < audio_dts_list.len() {
            let dur = audio_dts_list[i + 1] - audio_dts_list[i];
            audio_samples[i].duration = dur.max(1) as u32;
        } else {
            audio_samples[i].duration = 1024;
        }
    }

    let start = start_pts_s?;

    let has_video = !video_samples.is_empty();
    let has_audio = !audio_samples.is_empty();
    let has_cts = has_video && video_samples.iter().any(|s| s.cts != 0);

    let moof_size = compute_moof_size(video_track_id, audio_track_id,
        &video_samples, &audio_samples, video_timescale, audio_timescale, has_video, has_audio, has_cts);
    let data_offset = moof_size as u32 + 8;

    let mut buf = Vec::new();

    write_box(&mut buf, b"moof", |moof_buf| {
        write_mfhd(moof_buf, segment_sequence);

        if has_video {
            write_traf_with_offset(moof_buf, video_track_id, &video_samples, true, data_offset);
        }
        if has_audio {
            let audio_offset = if has_video { data_offset + video_data.len() as u32 } else { data_offset };
            write_traf_with_offset(moof_buf, audio_track_id, &audio_samples, false, audio_offset);
        }
    });

    write_box(&mut buf, b"mdat", |mdat_buf| {
        mdat_buf.extend_from_slice(&video_data);
        mdat_buf.extend_from_slice(&audio_data);
    });

    let duration_s = end_pts_s - start;

    Some(Fmp4MediaSegment {
        data: buf,
        video_samples: video_samples.len() as u32,
        audio_samples: audio_samples.len() as u32,
        start_time_s: start,
        duration_s,
    })
}

struct SampleInfo {
    duration: u32,
    size: u32,
    dts: i64,
    is_sync: bool,
    cts: i32,
}

fn fragment_sample_flags(is_sync: bool) -> u32 {
    if is_sync { 0x02000000 } else { 0x01010000 }
}

fn write_box(buf: &mut Vec<u8>, box_type: &[u8; 4], f: impl FnOnce(&mut Vec<u8>)) {
    let mut inner = Vec::new();
    f(&mut inner);
    let size = (8 + inner.len()) as u32;
    buf.extend_from_slice(&size.to_be_bytes());
    buf.extend_from_slice(box_type);
    buf.extend(inner);
}

fn write_full_box(buf: &mut Vec<u8>, box_type: &[u8; 4], version: u8, flags: u32, f: impl FnOnce(&mut Vec<u8>)) {
    let mut inner = Vec::new();
    f(&mut inner);
    let size = (12 + inner.len()) as u32;
    buf.extend_from_slice(&size.to_be_bytes());
    buf.extend_from_slice(box_type);
    buf.push(version);
    buf.extend_from_slice(&flags.to_be_bytes()[1..4]);
    buf.extend(inner);
}

fn write_mvhd(buf: &mut Vec<u8>, timescale: u32) {
    write_full_box(buf, b"mvhd", 0, 0, |b| {
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&timescale.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0x00010000u32.to_be_bytes());
        b.extend_from_slice(&0x0100u16.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
        for _ in 0..6 { b.extend_from_slice(&0u32.to_be_bytes()); }
        b.extend_from_slice(&0x00010000u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0x00010000u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0x40000000u32.to_be_bytes());
        for _ in 0..6 { b.extend_from_slice(&0u32.to_be_bytes()); }
        b.extend_from_slice(&2u32.to_be_bytes());
    });
}

fn write_tkhd(buf: &mut Vec<u8>, track_id: u32, width: u32, height: u32, is_audio: bool) {
    write_full_box(buf, b"tkhd", 0, 0x07, |b| {
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&track_id.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
        let volume: u16 = if is_audio { 0x0100 } else { 0x0000 };
        b.extend_from_slice(&volume.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
        b.extend_from_slice(&0x00010000u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0x00010000u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0x40000000u32.to_be_bytes());
        let w_fixed = (width as u32) << 16;
        let h_fixed = (height as u32) << 16;
        b.extend_from_slice(&w_fixed.to_be_bytes());
        b.extend_from_slice(&h_fixed.to_be_bytes());
    });
}

fn write_mdhd(buf: &mut Vec<u8>, timescale: u32) {
    write_full_box(buf, b"mdhd", 0, 0, |b| {
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&timescale.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0x55C40000u32.to_be_bytes());
    });
}

fn write_hdlr(buf: &mut Vec<u8>, handler_type: &[u8; 4], name: &[u8]) {
    write_full_box(buf, b"hdlr", 0, 0, |b| {
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(handler_type);
        for _ in 0..3 { b.extend_from_slice(&0u32.to_be_bytes()); }
        b.extend_from_slice(name);
        b.push(0);
    });
}

fn write_vmhd(buf: &mut Vec<u8>) {
    write_full_box(buf, b"vmhd", 0, 1, |b| {
        b.extend_from_slice(&0u16.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
    });
}

fn write_smhd(buf: &mut Vec<u8>) {
    write_full_box(buf, b"smhd", 0, 0, |b| {
        b.extend_from_slice(&0u16.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
    });
}

fn write_dinf(buf: &mut Vec<u8>) {
    write_box(buf, b"dinf", |b| {
        write_full_box(b, b"dref", 0, 0, |inner| {
            inner.extend_from_slice(&1u32.to_be_bytes());
            write_full_box(inner, b"url ", 0, 1, |_| {});
        });
    });
}

fn write_video_stbl(buf: &mut Vec<u8>, video: &VideoCodecConfig) {
    write_box(buf, b"stbl", |b| {
        write_full_box(b, b"stsd", 0, 0, |inner| {
            inner.extend_from_slice(&1u32.to_be_bytes());
            match video.codec {
                VideoCodec::Avc => write_avc1_entry(inner, video),
                VideoCodec::Hevc => write_hvc1_entry(inner, video),
            }
        });

        write_full_box(b, b"stts", 0, 0, |inner| {
            inner.extend_from_slice(&0u32.to_be_bytes());
        });
        write_full_box(b, b"stsc", 0, 0, |inner| {
            inner.extend_from_slice(&0u32.to_be_bytes());
        });
        write_full_box(b, b"stsz", 0, 0, |inner| {
            inner.extend_from_slice(&0u32.to_be_bytes());
            inner.extend_from_slice(&0u32.to_be_bytes());
        });
        write_full_box(b, b"stco", 0, 0, |inner| {
            inner.extend_from_slice(&0u32.to_be_bytes());
        });
    });
}

fn write_audio_stbl(buf: &mut Vec<u8>, audio: &AudioCodecConfig, _audio_timescale: u32) {
    write_box(buf, b"stbl", |b| {
        write_full_box(b, b"stsd", 0, 0, |inner| {
            inner.extend_from_slice(&1u32.to_be_bytes());
            write_mp4a_entry(inner, audio);
        });

        write_full_box(b, b"stts", 0, 0, |inner| {
            inner.extend_from_slice(&0u32.to_be_bytes());
        });
        write_full_box(b, b"stsc", 0, 0, |inner| {
            inner.extend_from_slice(&0u32.to_be_bytes());
        });
        write_full_box(b, b"stsz", 0, 0, |inner| {
            inner.extend_from_slice(&0u32.to_be_bytes());
            inner.extend_from_slice(&0u32.to_be_bytes());
        });
        write_full_box(b, b"stco", 0, 0, |inner| {
            inner.extend_from_slice(&0u32.to_be_bytes());
        });
    });
}

fn write_avc1_entry(buf: &mut Vec<u8>, video: &VideoCodecConfig) {
    let width = (video.width as u16).to_be_bytes();
    let height = (video.height as u16).to_be_bytes();

    write_box(buf, b"avc1", |b| {
        b.extend_from_slice(&[0u8; 6]);
        b.extend_from_slice(&1u16.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&width);
        b.extend_from_slice(&height);
        b.extend_from_slice(&0x00480000u32.to_be_bytes());
        b.extend_from_slice(&0x00480000u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&1u16.to_be_bytes());
        b.push(0);
        for _ in 0..31 { b.push(0); }
        b.extend_from_slice(&0x0018u16.to_be_bytes());
        b.extend_from_slice(&0xFFFFu16.to_be_bytes());
        write_avcc(b, &video.sps, &video.pps);
    });
}

fn write_hvc1_entry(buf: &mut Vec<u8>, video: &VideoCodecConfig) {
    let width = (video.width as u16).to_be_bytes();
    let height = (video.height as u16).to_be_bytes();

    write_box(buf, b"hvc1", |b| {
        b.extend_from_slice(&[0u8; 6]);
        b.extend_from_slice(&1u16.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&width);
        b.extend_from_slice(&height);
        b.extend_from_slice(&0x00480000u32.to_be_bytes());
        b.extend_from_slice(&0x00480000u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&1u16.to_be_bytes());
        b.push(0);
        for _ in 0..31 { b.push(0); }
        b.extend_from_slice(&0x0018u16.to_be_bytes());
        b.extend_from_slice(&0xFFFFu16.to_be_bytes());
        write_hvcc(b, video.vps.as_deref(), &video.sps, &video.pps);
    });
}

fn write_avcc(buf: &mut Vec<u8>, sps: &[u8], pps: &[u8]) {
    write_box(buf, b"avcC", |b| {
        b.push(1);
        b.push(sps.get(1).copied().unwrap_or(66));
        b.push(sps.get(2).copied().unwrap_or(0xC0));
        b.push(sps.get(3).copied().unwrap_or(30));
        b.push(0xFF);
        b.push(0xE1);
        b.extend_from_slice(&(sps.len() as u16).to_be_bytes());
        b.extend_from_slice(sps);
        b.push(1);
        b.extend_from_slice(&(pps.len() as u16).to_be_bytes());
        b.extend_from_slice(pps);
    });
}

fn write_hvcc(buf: &mut Vec<u8>, vps: Option<&[u8]>, sps: &[u8], pps: &[u8]) {
    write_box(buf, b"hvcC", |b| {
        b.push(1);
        let profile_idc = sps.get(1).copied().unwrap_or(1);
        b.push(profile_idc);
        b.extend_from_slice(&0x60000000u32.to_be_bytes());
        b.extend_from_slice(&[0u8; 6]);
        let level_idc = sps.get(3).copied().unwrap_or(93);
        b.push(level_idc);
        b.extend_from_slice(&0xF000u16.to_be_bytes());
        b.push(0xFC);
        b.push(0xFD);
        b.push(0xF8);
        b.push(0xF8);
        b.extend_from_slice(&0u16.to_be_bytes());
        b.push(0x0F);

        let vps_data = vps.unwrap_or(&[]);
        let num_arrays: u8 = if vps_data.is_empty() { 2 } else { 3 };
        b.push(num_arrays);

        if !vps_data.is_empty() {
            b.push(0xA0);
            b.extend_from_slice(&1u16.to_be_bytes());
            b.extend_from_slice(&(vps_data.len() as u16).to_be_bytes());
            b.extend_from_slice(vps_data);
        }

        b.push(0xA1);
        b.extend_from_slice(&1u16.to_be_bytes());
        b.extend_from_slice(&(sps.len() as u16).to_be_bytes());
        b.extend_from_slice(sps);

        b.push(0xA2);
        b.extend_from_slice(&1u16.to_be_bytes());
        b.extend_from_slice(&(pps.len() as u16).to_be_bytes());
        b.extend_from_slice(pps);
    });
}

fn write_mp4a_entry(buf: &mut Vec<u8>, audio: &AudioCodecConfig) {
    let samplerate_fixed = (audio.sampling_freq as u32) << 16;
    write_box(buf, b"mp4a", |b| {
        b.extend_from_slice(&[0u8; 6]);
        b.extend_from_slice(&1u16.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&(audio.channel_config as u16).to_be_bytes());
        b.extend_from_slice(&0x0010u16.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
        b.extend_from_slice(&samplerate_fixed.to_be_bytes());
        write_esds(b, audio);
    });
}

fn write_esds(buf: &mut Vec<u8>, audio: &AudioCodecConfig) {
    write_full_box(buf, b"esds", 0, 0, |b| {
        let is_sbr = audio.audio_object_type == 5 || audio.audio_object_type == 29;
        let freq_idx = audio.sampling_freq_index;
        let ch_cfg = audio.channel_config;

        let config_bytes = if is_sbr {
            let core_freq_idx = if freq_idx >= 3 { freq_idx - 3 } else { freq_idx };
            let byte0 = (5u8 << 3) | (freq_idx >> 1) as u8;
            let byte1 = ((freq_idx & 1) << 7) | (ch_cfg << 3) | (2u8 >> 2) as u8;
            let byte2 = ((2u8 & 0x03) << 6) | (core_freq_idx << 2) as u8;
            vec![byte0, byte1, byte2]
        } else {
            let aot = audio.audio_object_type;
            let byte0 = (aot << 3) | (freq_idx >> 1) as u8;
            let byte1 = ((freq_idx & 1) << 7) | (ch_cfg << 3);
            vec![byte0, byte1]
        };

        let ds_content_len = config_bytes.len();
        let dc_content_len = 1 + 1 + 3 + 4 + 4 + (1 + 1 + ds_content_len);
        let es_content_len = 2 + 1 + (1 + 1 + dc_content_len) + (1 + 1 + 1);

        b.push(0x03);
        write_desc_length(b, es_content_len);
        b.extend_from_slice(&0x0001u16.to_be_bytes());
        b.push(0x00);

        b.push(0x04);
        write_desc_length(b, dc_content_len);
        b.push(0x40);
        b.push(0x15);
        b.extend_from_slice(&[0u8; 3]);
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());

        b.push(0x05);
        write_desc_length(b, ds_content_len);
        b.extend_from_slice(&config_bytes);

        b.push(0x06);
        b.push(0x01);
        b.push(0x02);
    });
}

fn write_desc_length(buf: &mut Vec<u8>, len: usize) {
    if len < 128 {
        buf.push(len as u8);
    } else if len < 16384 {
        buf.push(((len >> 7) & 0x7F) as u8 | 0x80);
        buf.push((len & 0x7F) as u8);
    } else {
        buf.push(((len >> 21) & 0x7F) as u8 | 0x80);
        buf.push(((len >> 14) & 0x7F) as u8 | 0x80);
        buf.push(((len >> 7) & 0x7F) as u8 | 0x80);
        buf.push((len & 0x7F) as u8);
    }
}

fn write_trex(buf: &mut Vec<u8>, track_id: u32) {
    write_full_box(buf, b"trex", 0, 0, |b| {
        b.extend_from_slice(&track_id.to_be_bytes());
        b.extend_from_slice(&1u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0x02010000u32.to_be_bytes());
    });
}

fn write_mfhd(buf: &mut Vec<u8>, sequence_number: u32) {
    write_full_box(buf, b"mfhd", 0, 0, |b| {
        b.extend_from_slice(&sequence_number.to_be_bytes());
    });
}

fn compute_moof_size(
    _video_track_id: u32, _audio_track_id: u32,
    video_samples: &[SampleInfo], audio_samples: &[SampleInfo],
    _video_timescale: u32, _audio_timescale: u32,
    has_video: bool, has_audio: bool, has_cts: bool,
) -> usize {
    let mut size = 8;
    size += compute_mfhd_size();
    if has_video {
        size += compute_traf_size(video_samples, has_cts);
    }
    if has_audio {
        size += compute_traf_size(audio_samples, false);
    }
    size
}

fn compute_mfhd_size() -> usize { 16 }

fn compute_traf_size(samples: &[SampleInfo], has_cts: bool) -> usize {
    if samples.is_empty() { return 0; }

    let default_duration = samples.get(1).or(samples.get(0)).map(|s| s.duration).unwrap_or(0);
    let default_size = samples.get(1).or(samples.get(0)).map(|s| s.size).unwrap_or(0);
    let default_is_sync = samples.get(1).or(samples.get(0)).map(|s| s.is_sync).unwrap_or(true);
    let default_flags = fragment_sample_flags(default_is_sync);

    let first_differs = samples[0].is_sync != default_is_sync;
    let use_first_sample_flags = first_differs && samples.len() > 1;
    let dur_differs = samples.iter().any(|s| s.duration != default_duration);
    let size_differs = samples.iter().any(|s| s.size != default_size);
    let flags_differ = !use_first_sample_flags && samples.iter().any(|s| fragment_sample_flags(s.is_sync) != default_flags);
    let use_cts = has_cts && samples.iter().any(|s| s.cts != 0);

    let tfhd_size = 12 + 4 + 4 + 4 + 4;
    let tfdt_size = 12 + 8;

    let mut trun_per_sample: usize = 0;
    if dur_differs { trun_per_sample += 4; }
    if size_differs { trun_per_sample += 4; }
    if flags_differ { trun_per_sample += 4; }
    if use_cts { trun_per_sample += 4; }

    let trun_overhead = 12 + 4 + 4;
    let first_sample_flags_size = if use_first_sample_flags { 4 } else { 0 };
    let trun_size = trun_overhead + first_sample_flags_size + samples.len() * trun_per_sample;

    8 + tfhd_size + tfdt_size + trun_size
}

fn write_traf_with_offset(buf: &mut Vec<u8>, track_id: u32, samples: &[SampleInfo], has_cts: bool, data_offset: u32) {
    if samples.is_empty() { return; }

    let default_duration = samples.get(1).or(samples.get(0)).map(|s| s.duration).unwrap_or(0);
    let default_size = samples.get(1).or(samples.get(0)).map(|s| s.size).unwrap_or(0);
    let default_flags = fragment_sample_flags(samples.get(1).or(samples.get(0)).map(|s| s.is_sync).unwrap_or(true));

    let first_differs = !samples.is_empty() && samples[0].is_sync != samples.get(1).map(|s| s.is_sync).unwrap_or(true);
    let use_first_sample_flags = first_differs && samples.len() > 1;

    let dur_differs = samples.iter().any(|s| s.duration != default_duration);
    let size_differs = samples.iter().any(|s| s.size != default_size);
    let flags_differ = !use_first_sample_flags && samples.iter().any(|s| fragment_sample_flags(s.is_sync) != default_flags);
    let use_cts = has_cts && samples.iter().any(|s| s.cts != 0);

    let mut tfhd_flags: u32 = 0x020000;
    tfhd_flags |= 0x000008;
    tfhd_flags |= 0x000010;
    tfhd_flags |= 0x000020;

    write_box(buf, b"traf", |b| {
        write_full_box(b, b"tfhd", 0, tfhd_flags, |inner| {
            inner.extend_from_slice(&track_id.to_be_bytes());
            inner.extend_from_slice(&default_duration.to_be_bytes());
            inner.extend_from_slice(&default_size.to_be_bytes());
            inner.extend_from_slice(&default_flags.to_be_bytes());
        });

        write_full_box(b, b"tfdt", 1, 0, |inner| {
            inner.extend_from_slice(&samples[0].dts.to_be_bytes());
        });

        let mut trun_flags: u32 = 0x000001;
        if use_first_sample_flags { trun_flags |= 0x000004; }
        if dur_differs { trun_flags |= 0x000100; }
        if size_differs { trun_flags |= 0x000200; }
        if flags_differ { trun_flags |= 0x000400; }
        if use_cts { trun_flags |= 0x000800; }

        let sample_count = samples.len() as u32;
        write_full_box(b, b"trun", 1, trun_flags, |b2| {
            b2.extend_from_slice(&sample_count.to_be_bytes());
            b2.extend_from_slice(&data_offset.to_be_bytes());
            if use_first_sample_flags {
                b2.extend_from_slice(&fragment_sample_flags(samples[0].is_sync).to_be_bytes());
            }

            for sample in samples {
                if dur_differs { b2.extend_from_slice(&sample.duration.to_be_bytes()); }
                if size_differs { b2.extend_from_slice(&sample.size.to_be_bytes()); }
                if flags_differ { b2.extend_from_slice(&fragment_sample_flags(sample.is_sync).to_be_bytes()); }
                if use_cts { b2.extend_from_slice(&sample.cts.to_be_bytes()); }
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ts_demux::{VideoCodec, AudioCodecConfig};

    fn make_test_video_config() -> VideoCodecConfig {
        let sps = vec![0x64, 0x00, 0x28, 0xAC, 0x2C, 0xA0, 0x1E, 0x00, 0x89, 0xF9, 0x60];
        let pps = vec![0x68, 0xCE, 0x38, 0x80];
        VideoCodecConfig {
            codec: VideoCodec::Avc,
            sps: sps.clone(),
            pps: pps.clone(),
            vps: None,
            width: 1280,
            height: 720,
        }
    }

    fn make_test_audio_config() -> AudioCodecConfig {
        AudioCodecConfig {
            audio_object_type: 2,
            sampling_freq_index: 3,
            channel_config: 2,
            sampling_freq: 48000,
        }
    }

    fn read_box_header(data: &[u8], offset: usize) -> Option<(u32, [u8; 4], usize)> {
        if offset + 8 > data.len() { return None; }
        let size = u32::from_be_bytes([data[offset], data[offset+1], data[offset+2], data[offset+3]]);
        let mut box_type = [0u8; 4];
        box_type.copy_from_slice(&data[offset+4..offset+8]);
        Some((size, box_type, offset))
    }

    #[test]
    fn test_init_segment_has_ftyp() {
        let video = make_test_video_config();
        let audio = make_test_audio_config();
        let init = build_init_segment(&video, &audio);
        let (_, btype, _) = read_box_header(&init.data, 0).unwrap();
        assert_eq!(&btype, b"ftyp", "First box should be ftyp");
    }

    #[test]
    fn test_init_segment_has_moov() {
        let video = make_test_video_config();
        let audio = make_test_audio_config();
        let init = build_init_segment(&video, &audio);
        let mut offset = 0;
        let mut found_moov = false;
        while let Some((size, btype, _)) = read_box_header(&init.data, offset) {
            if btype == *b"moov" { found_moov = true; break; }
            offset += size as usize;
        }
        assert!(found_moov, "Init segment should contain moov box");
    }

    #[test]
    fn test_init_segment_mime_type() {
        let video = make_test_video_config();
        let audio = make_test_audio_config();
        let init = build_init_segment(&video, &audio);
        assert!(init.mime_type.contains("avc1"), "MIME type should contain avc1");
        assert!(init.mime_type.contains("mp4a"), "MIME type should contain mp4a");
        assert!(init.mime_type.starts_with("video/mp4"), "MIME type should start with video/mp4");
    }

    #[test]
    fn test_init_segment_has_two_trak_boxes() {
        let video = make_test_video_config();
        let audio = make_test_audio_config();
        let init = build_init_segment(&video, &audio);
        let mut trak_count = 0;
        let mut off = 0;
        while let Some((size, btype, _)) = read_box_header(&init.data, off) {
            if btype == *b"moov" {
                let moov_start = off + 8;
                let moov_end = off + size as usize;
                let moov_inner = &init.data[moov_start..moov_end];
                let mut inner_off = 0;
                while let Some((csize, ctype, _)) = read_box_header(moov_inner, inner_off) {
                    if ctype == *b"trak" { trak_count += 1; }
                    inner_off += csize as usize;
                    if inner_off >= moov_inner.len() { break; }
                }
                break;
            }
            off += size as usize;
            if off >= init.data.len() { break; }
        }
        assert_eq!(trak_count, 2, "moov should contain exactly 2 trak boxes (video + audio)");
    }

    #[test]
    fn test_media_segment_moof_mdat_structure() {
        let video_frame1 = PesFrame {
            pts: 90000,
            dts: 81000,
            has_dts: true,
            is_keyframe: true,
            data: vec![0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00],
            stream_type: 0x1B,
        };
        let video_frame2 = PesFrame {
            pts: 93000,
            dts: 84000,
            has_dts: true,
            is_keyframe: false,
            data: vec![0x00, 0x00, 0x00, 0x01, 0x21, 0x88, 0x84],
            stream_type: 0x1B,
        };
        let audio_frame = PesFrame {
            pts: 95000,
            dts: 95000,
            has_dts: false,
            is_keyframe: false,
            data: vec![0x11, 0x90, 0x00, 0x03],
            stream_type: 0x0F,
        };
        let frames = vec![video_frame1, video_frame2, audio_frame];

        let seg = build_media_segment(&frames, 1, 2, 90000, 48000, 1);
        assert!(seg.is_some(), "Should build media segment from frames");
        let seg = seg.unwrap();
        assert!(seg.video_samples > 0, "Should have video samples");
        assert!(seg.audio_samples > 0, "Should have audio samples");
        assert!(seg.start_time_s >= 0.0, "Start time should be non-negative");
        assert!(seg.duration_s > 0.0, "Duration should be positive");

        let (size, btype, _) = read_box_header(&seg.data, 0).unwrap();
        assert_eq!(&btype, b"moof", "First box in media segment should be moof");

        let moof_end = size as usize;
        let (mdat_size, mdat_type, _) = read_box_header(&seg.data, moof_end).unwrap();
        assert_eq!(&mdat_type, b"mdat", "Second box in media segment should be mdat");

        let total_size = moof_end + mdat_size as usize;
        assert_eq!(total_size, seg.data.len(), "moof + mdat should account for entire segment");
    }

    #[test]
    fn test_media_segment_data_offset_correctness() {
        let video_frame = PesFrame {
            pts: 90000,
            dts: 81000,
            has_dts: true,
            is_keyframe: true,
            data: vec![0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84],
            stream_type: 0x1B,
        };
        let audio_frame = PesFrame {
            pts: 95000,
            dts: 95000,
            has_dts: false,
            is_keyframe: false,
            data: vec![0x11, 0x90, 0x00, 0x03],
            stream_type: 0x0F,
        };
        let frames = vec![video_frame, audio_frame];

        let seg = build_media_segment(&frames, 1, 2, 90000, 48000, 1).unwrap();

        if let Some((moof_size, _, _)) = read_box_header(&seg.data, 0) {
            let mdat_start = moof_size as usize;
            if let Some((mdat_size, _, _)) = read_box_header(&seg.data, mdat_start) {
                let mdat_inner_start = mdat_start + 8;
                let mdat_inner_end = mdat_start + mdat_size as usize;
                assert!(mdat_inner_end <= seg.data.len(), "mdat should not exceed segment bounds");
                assert!(!seg.data[mdat_inner_start..mdat_inner_end].is_empty(), "mdat should contain actual media data");
            }
        }
    }

    #[test]
    fn test_empty_frames_no_segment() {
        let frames: Vec<PesFrame> = vec![];
        let seg = build_media_segment(&frames, 1, 2, 90000, 48000, 1);
        assert!(seg.is_none(), "Empty frames should produce no segment");
    }

    #[test]
    fn test_fragment_sample_flags() {
        assert_eq!(fragment_sample_flags(true), 0x02000000, "Keyframe flags should be 0x02000000");
        assert_eq!(fragment_sample_flags(false), 0x01010000, "Non-keyframe flags should be 0x01010000");
    }
}
