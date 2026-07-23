use std::collections::HashMap;

const TS_PACKET_SIZE: usize = 188;
const TS_SYNC_BYTE: u8 = 0x47;
pub const PTS_CLOCK_RATE: u64 = 90000;

const H264_STREAM_TYPE: u8 = 0x1b;
const HEVC_STREAM_TYPE: u8 = 0x24;
const AAC_STREAM_TYPE: u8 = 0x0f;
const AAC_LATM_STREAM_TYPE: u8 = 0x15;

const H264_NAL_SPS: u8 = 7;
const H264_NAL_PPS: u8 = 8;
const H264_NAL_IDR: u8 = 5;
const H264_NAL_AUD: u8 = 9; // Access Unit Delimiter — always starts a new AU
const HEVC_NAL_VPS: u8 = 32;
const HEVC_NAL_SPS: u8 = 33;
const HEVC_NAL_PPS: u8 = 34;
const HEVC_NAL_IDR_W: u8 = 19;
const HEVC_NAL_IDR_N: u8 = 20;

#[derive(Debug, Clone)]
pub struct TsStreamInfo {
    pub video_pid: u16,
    pub audio_pid: u16,
    pub video_stream_type: u8,
    pub audio_stream_type: u8,
    pub pmt_pid: u16,
}

#[derive(Debug, Clone)]
pub struct VideoCodecConfig {
    pub codec: VideoCodec,
    pub sps: Vec<u8>,
    pub pps: Vec<u8>,
    pub vps: Option<Vec<u8>>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum VideoCodec {
    Avc,
    Hevc,
}

#[derive(Debug, Clone)]
pub struct AudioCodecConfig {
    pub audio_object_type: u8,
    pub sampling_freq_index: u8,
    pub channel_config: u8,
    pub sampling_freq: u32,
}

#[derive(Debug, Clone)]
pub struct PesFrame {
    pub pts: u64,
    pub dts: u64,
    pub has_dts: bool,
    pub is_keyframe: bool,
    pub data: Vec<u8>,
    pub stream_type: u8,
}

fn parse_pat(data: &[u8], offset: usize) -> Option<(u16, u16)> {
    if offset + TS_PACKET_SIZE > data.len() { return None; }
    let pkt = &data[offset..offset + TS_PACKET_SIZE];
    if pkt[0] != TS_SYNC_BYTE { return None; }
    let pid = ((pkt[1] as u16 & 0x1F) << 8) | pkt[2] as u16;
    if pid != 0x0000 { return None; }

    let pusi = (pkt[1] >> 6) & 0x01;
    let afc = (pkt[3] >> 4) & 0x03;
    let mut payload_offset = 4;
    if afc & 0x02 != 0 {
        let af_len = pkt[4] as usize;
        payload_offset += 1 + af_len;
    }
    if payload_offset >= TS_PACKET_SIZE || pusi != 1 { return None; }

    let pointer = pkt[payload_offset] as usize;
    let section_start = payload_offset + 1 + pointer;
    if section_start + 8 >= TS_PACKET_SIZE { return None; }
    if pkt[section_start] != 0x00 { return None; }

    let section_length = (((pkt[section_start + 1] & 0x0F) as u16) << 8) | pkt[section_start + 2] as u16;
    let entry_end = section_start + 3 + section_length as usize - 4;
    let mut pos = section_start + 8;
    while pos + 4 <= entry_end.min(TS_PACKET_SIZE) {
        let prog_num = ((pkt[pos] as u16) << 8) | pkt[pos + 1] as u16;
        if prog_num != 0 {
            let pmt_pid = ((pkt[pos + 2] as u16 & 0x1F) << 8) | pkt[pos + 3] as u16;
            return Some((prog_num, pmt_pid));
        }
        pos += 4;
    }
    None
}

fn parse_pmt(data: &[u8], offset: usize, pmt_pid: u16) -> Option<TsStreamInfo> {
    if offset + TS_PACKET_SIZE > data.len() { return None; }
    let pkt = &data[offset..offset + TS_PACKET_SIZE];
    if pkt[0] != TS_SYNC_BYTE { return None; }
    let pid = ((pkt[1] as u16 & 0x1F) << 8) | pkt[2] as u16;
        if pid != pmt_pid && pid != 0x1000 && pid != 0x0FFF { return None; }

    let pusi = (pkt[1] >> 6) & 0x01;
    let afc = (pkt[3] >> 4) & 0x03;
    let mut payload_offset = 4;
    if afc & 0x02 != 0 {
        let af_len = pkt[4] as usize;
        payload_offset += 1 + af_len;
    }
    if payload_offset >= TS_PACKET_SIZE || pusi != 1 { return None; }

    let pointer = pkt[payload_offset] as usize;
    let section_start = payload_offset + 1 + pointer;
    if section_start + 12 > TS_PACKET_SIZE { return None; }
    if pkt[section_start] != 0x02 { return None; }

    let section_length = (((pkt[section_start + 1] & 0x0F) as u16) << 8) | pkt[section_start + 2] as u16;
    let program_info_length = (((pkt[section_start + 10] & 0x0F) as u16) << 8) | pkt[section_start + 11] as u16;
    let crc_end = section_start + 3 + section_length as usize - 4;

    let mut video_pid: Option<u16> = None;
    let mut audio_pid: Option<u16> = None;
    let mut video_stream_type: u8 = 0;
    let mut audio_stream_type: u8 = 0;

    let mut pos = section_start + 12 + program_info_length as usize;
    while pos + 5 <= crc_end.min(TS_PACKET_SIZE) {
        let stream_type = pkt[pos];
        let es_pid = ((pkt[pos + 1] as u16 & 0x1F) << 8) | pkt[pos + 2] as u16;
        let es_info_length = ((pkt[pos + 3] as u16 & 0x0F) << 8) | pkt[pos + 4] as u16;

        match stream_type {
            H264_STREAM_TYPE | HEVC_STREAM_TYPE => {
                if video_pid.is_none() {
                    video_pid = Some(es_pid);
                    video_stream_type = stream_type;
                }
            }
            AAC_STREAM_TYPE | AAC_LATM_STREAM_TYPE => {
                if audio_pid.is_none() {
                    audio_pid = Some(es_pid);
                    audio_stream_type = stream_type;
                }
            }
            _ => {}
        }
        pos += 5 + es_info_length as usize;
    }

    Some(TsStreamInfo {
        video_pid: video_pid?,
        audio_pid: audio_pid?,
        video_stream_type,
        audio_stream_type,
        pmt_pid,
    })
}

pub fn extract_stream_info(data: &[u8]) -> Option<TsStreamInfo> {
    let mut pmt_pid: Option<u16> = None;

    for offset in (0..data.len()).step_by(TS_PACKET_SIZE) {
        if offset + TS_PACKET_SIZE > data.len() { break; }
        if data[offset] != TS_SYNC_BYTE { continue; }

        let pid = ((data[offset + 1] as u16 & 0x1F) << 8) | data[offset + 2] as u16;
        if pid == 0x0000 {
            if let Some((_, pmt)) = parse_pat(data, offset) {
                pmt_pid = Some(pmt);
                break;
            }
        }
    }

    let pmt_pid = pmt_pid?;

    for offset in (0..data.len()).step_by(TS_PACKET_SIZE) {
        if offset + TS_PACKET_SIZE > data.len() { break; }
        if data[offset] != TS_SYNC_BYTE { continue; }
        let pid = ((data[offset + 1] as u16 & 0x1F) << 8) | data[offset + 2] as u16;
        if pid == pmt_pid || pid == 0x1000 || pid == 0x0FFF {
            if let Some(info) = parse_pmt(data, offset, pmt_pid) {
                return Some(info);
            }
        }
    }
    None
}

fn extract_pts_dts(pes_data: &[u8]) -> Option<(u64, u64, bool)> {
    if pes_data.len() < 9 { return None; }
    if pes_data[0] != 0x00 || pes_data[1] != 0x00 || pes_data[2] != 0x01 { return None; }

    let pts_dts_flags = (pes_data[7] >> 6) & 0x03;
    let header_data_length = pes_data[8] as usize;

    if pts_dts_flags == 0 { return None; }

    if pts_dts_flags >= 0x02 && header_data_length < 5 { return None; }
    if pts_dts_flags == 0x03 && header_data_length < 10 { return None; }

    let pts_offset = 9;
    if pts_offset + header_data_length > pes_data.len() { return None; }

    let pts = extract_33bit_timestamp(&pes_data[pts_offset..]);
    let has_dts = pts_dts_flags == 0x03;

    let dts = if has_dts && pts_offset + 10 <= pes_data.len() {
        extract_33bit_timestamp(&pes_data[pts_offset + 5..])
    } else {
        pts
    };

    Some((pts, dts, has_dts))
}

fn extract_33bit_timestamp(data: &[u8]) -> u64 {
    if data.len() < 5 { return 0; }
    let ts = ((data[0] as u64 >> 1) & 0x07) << 30
        | (data[1] as u64) << 22
        | ((data[2] as u64 >> 1) & 0x7f) << 15
        | (data[3] as u64) << 7
        | ((data[4] as u64 >> 1) & 0x7f);
    ts
}

fn parse_adts_header(data: &[u8]) -> Option<AudioCodecConfig> {
    if data.len() < 7 { return None; }
    if data[0] != 0xFF || (data[1] & 0xF0) != 0xF0 { return None; }

    let audio_object_type = ((data[2] >> 6) & 0x03) + 1;
    let sampling_freq_index = (data[2] >> 2) & 0x0F;
    let channel_config = ((data[2] & 0x01) << 2) | ((data[3] >> 6) & 0x03);

    let sampling_freq = match sampling_freq_index {
        0 => 96000, 1 => 88200, 2 => 64000, 3 => 48000,
        4 => 44100, 5 => 32000, 6 => 24000, 7 => 22050,
        8 => 16000, 9 => 12000, 10 => 11025, 11 => 8000,
        12 => 7350, _ => 44100,
    };

    Some(AudioCodecConfig {
        audio_object_type,
        sampling_freq_index,
        channel_config,
        sampling_freq,
    })
}

pub struct TsDemuxer {
    stream_info: Option<TsStreamInfo>,
    pes_buffers: HashMap<u16, Vec<u8>>,
    video_codec_config: Option<VideoCodecConfig>,
    audio_codec_config: Option<AudioCodecConfig>,
    frames: Vec<PesFrame>,
    video_config_found: bool,
    audio_config_found: bool,
    pending_sps: Option<Vec<u8>>,
    pending_pps: Option<Vec<u8>>,
    pending_vps: Option<Vec<u8>>,
}

impl TsDemuxer {
    pub fn new() -> Self {
        Self {
            stream_info: None,
            pes_buffers: HashMap::new(),
            video_codec_config: None,
            audio_codec_config: None,
            frames: Vec::new(),
            video_config_found: false,
            audio_config_found: false,
            pending_sps: None,
            pending_pps: None,
            pending_vps: None,
        }
    }

    pub fn with_stream_info(mut self, info: TsStreamInfo) -> Self {
        self.stream_info = Some(info);
        self
    }

    pub fn feed(&mut self, data: &[u8]) {
        let mut offset = 0;
        while offset + TS_PACKET_SIZE <= data.len() {
            if data[offset] != TS_SYNC_BYTE {
                offset += 1;
                continue;
            }
            self.process_ts_packet(&data[offset..offset + TS_PACKET_SIZE]);
            offset += TS_PACKET_SIZE;
        }
    }

    fn process_ts_packet(&mut self, pkt: &[u8]) {
        let pid = ((pkt[1] as u16 & 0x1F) << 8) | pkt[2] as u16;
        let pusi = (pkt[1] >> 6) & 0x01;
        let afc = (pkt[3] >> 4) & 0x03;

        if pid == 0x0000 || pid == 0x1FFF { return; }

        let stream_info = match &self.stream_info {
            Some(si) => si,
            None => return,
        };

        let is_video = pid == stream_info.video_pid;
        let is_audio = pid == stream_info.audio_pid;

        if !is_video && !is_audio { return; }

        let mut payload_offset: usize = 4;
        if afc & 0x02 != 0 {
            if payload_offset >= TS_PACKET_SIZE { return; }
            let af_len = pkt[payload_offset] as usize;
            payload_offset += 1 + af_len;
        }
        if afc & 0x01 == 0 { return; }
        if payload_offset >= TS_PACKET_SIZE { return; }

        let payload = &pkt[payload_offset..TS_PACKET_SIZE];

        if pusi == 1 {
            let prev_buf = self.pes_buffers.remove(&pid);
            if let Some(ref prev_buf_data) = prev_buf {
                if !prev_buf_data.is_empty() {
                    self.complete_pes(pid, prev_buf_data);
                }
            }
            self.pes_buffers.insert(pid, payload.to_vec());
        } else {
            if let Some(buf) = self.pes_buffers.get_mut(&pid) {
                buf.extend_from_slice(payload);
            }
        }
    }

    fn complete_pes(&mut self, pid: u16, pes_data: &[u8]) {
        let stream_info = match &self.stream_info {
            Some(si) => si,
            None => return,
        };

        let is_video = pid == stream_info.video_pid;
        let is_audio = pid == stream_info.audio_pid;

        if is_video {
            self.process_video_pes(pes_data);
        } else if is_audio {
            self.process_audio_pes(pes_data);
        }
    }

    fn process_video_pes(&mut self, pes_data: &[u8]) {
        let stream_info = match &self.stream_info {
            Some(si) => si.clone(),
            None => return,
        };

        if pes_data.len() < 9 { return; }
        if pes_data[0] != 0x00 || pes_data[1] != 0x00 || pes_data[2] != 0x01 { return; }

        let (pts, dts, has_dts) = match extract_pts_dts(pes_data) {
            Some(v) => v,
            None => return,
        };

        let header_data_length = pes_data[8] as usize;
        let es_data_offset = 9 + header_data_length;
        if es_data_offset >= pes_data.len() { return; }
        let es_data = &pes_data[es_data_offset..];

        if !self.video_config_found {
            self.extract_video_config(es_data, stream_info.video_stream_type);
            if self.video_codec_config.is_some() {
                self.video_config_found = true;
            }
        }

        // Split multi-AU (Access Unit) video PES into individual frames.
        // Many TS streams (including Telegram's) set pusi=1 only at keyframes,
        // meaning a single video PES can span an entire GOP (4-10s of frames).
        // Without splitting, the entire GOP becomes ONE fMP4 sample → Chrome
        // assigns it 33ms duration → all frames decoded at once → massive gaps.
        let access_units = split_video_access_units(es_data, stream_info.video_stream_type);

        if access_units.is_empty() {
            // Fallback: emit the whole PES as one frame (legacy behavior)
            let is_keyframe = detect_keyframe(es_data, stream_info.video_stream_type);
            self.frames.push(PesFrame {
                pts, dts, has_dts, is_keyframe,
                data: es_data.to_vec(),
                stream_type: stream_info.video_stream_type,
            });
            return;
        }

        if access_units.len() == 1 {
            // Single AU — no splitting needed
            let is_keyframe = detect_keyframe(&access_units[0], stream_info.video_stream_type);
            self.frames.push(PesFrame {
                pts, dts, has_dts, is_keyframe,
                data: access_units.into_iter().next().unwrap(),
                stream_type: stream_info.video_stream_type,
            });
            return;
        }

        // Multi-AU PES: split into individual frames with incrementing PTS/DTS.
        // Compute per-frame PTS/DTS increment based on typical frame duration.
        // For H.264 at 25fps: 3600 ticks (40ms). For 30fps: 3003 ticks (33ms).
        // We estimate from the PES header's PTS and the number of AUs.
        let base_dts = if has_dts { dts } else { pts };
        let num_aus = access_units.len() as u64;

        // Estimate frame duration: if we know the total PTS span, divide evenly.
        // Otherwise, use a default based on typical frame rates.
        // For a GOP spanning N frames at ~25fps, each frame ≈ 3600 PTS ticks.
        let frame_duration_pts: u64 = if num_aus > 1 {
            // Default: 40ms per frame (25fps). Will be refined by fMP4 builder.
            3600
        } else {
            3600
        };

        for (i, au_data) in access_units.into_iter().enumerate() {
            let frame_pts = pts + (i as u64) * frame_duration_pts;
            let frame_dts = base_dts + (i as u64) * frame_duration_pts;
            let is_keyframe = detect_keyframe(&au_data, stream_info.video_stream_type);

            self.frames.push(PesFrame {
                pts: frame_pts,
                dts: frame_dts,
                has_dts,
                is_keyframe,
                data: au_data,
                stream_type: stream_info.video_stream_type,
            });
        }
    }

    fn process_audio_pes(&mut self, pes_data: &[u8]) {
        let stream_info = match &self.stream_info {
            Some(si) => si,
            None => return,
        };

        if pes_data.len() < 9 { return; }
        if pes_data[0] != 0x00 || pes_data[1] != 0x00 || pes_data[2] != 0x01 { return; }

        let (pts, _dts, _) = match extract_pts_dts(pes_data) {
            Some(v) => v,
            None => return,
        };

        let header_data_length = pes_data[8] as usize;
        let es_data_offset = 9 + header_data_length;
        if es_data_offset >= pes_data.len() { return; }
        let es_data = &pes_data[es_data_offset..];

        if !self.audio_config_found {
            if let Some(audio_cfg) = parse_adts_header(es_data) {
                self.audio_codec_config = Some(audio_cfg);
                self.audio_config_found = true;
            }
        }

        // Compute per-AAC-frame PTS increment.
        // Each AAC frame represents 1024 samples at the sampling frequency.
        // PTS increment per frame = 1024 * 90000 / sampling_freq.
        let sampling_freq = self.audio_codec_config
            .as_ref()
            .map(|c| c.sampling_freq as u64)
            .unwrap_or(48000);
        let aac_frame_duration_pts = 1024 * 90000 / sampling_freq;

        let aac_frames = extract_aac_frames(es_data);
        for (i, frame_data) in aac_frames.into_iter().enumerate() {
            let frame_pts = pts + (i as u64) * aac_frame_duration_pts;
            self.frames.push(PesFrame {
                pts: frame_pts,
                dts: frame_pts, // audio has no B-frames, DTS == PTS
                has_dts: false,
                is_keyframe: false,
                data: frame_data,
                stream_type: stream_info.audio_stream_type,
            });
        }
    }

    fn extract_video_config(&mut self, es_data: &[u8], stream_type: u8) {
        match stream_type {
            H264_STREAM_TYPE => self.extract_avc_config(es_data),
            HEVC_STREAM_TYPE => self.extract_hevc_config(es_data),
            _ => {}
        }
    }

    fn extract_avc_config(&mut self, data: &[u8]) {
        let nals = split_nal_units_annex_b(data);
        for nal in &nals {
            if nal.is_empty() { continue; }
            let nal_type = nal[0] & 0x1F;
            match nal_type {
                H264_NAL_SPS => self.pending_sps = Some(nal.clone()),
                H264_NAL_PPS => self.pending_pps = Some(nal.clone()),
                _ => {}
            }
        }

        if let (Some(sps_data), Some(pps_data)) = (&self.pending_sps, &self.pending_pps) {
            let (w, h) = parse_sps_dimensions(sps_data);
            self.video_codec_config = Some(VideoCodecConfig {
                codec: VideoCodec::Avc,
                sps: sps_data.clone(),
                pps: pps_data.clone(),
                vps: None,
                width: w,
                height: h,
            });
        }
    }

    fn extract_hevc_config(&mut self, data: &[u8]) {
        let nals = split_nal_units_annex_b(data);
        for nal in &nals {
            if nal.is_empty() { continue; }
            let nal_type = (nal[0] >> 1) & 0x3F;
            match nal_type {
                HEVC_NAL_VPS => self.pending_vps = Some(nal.clone()),
                HEVC_NAL_SPS => self.pending_sps = Some(nal.clone()),
                HEVC_NAL_PPS => self.pending_pps = Some(nal.clone()),
                _ => {}
            }
        }

        if let (Some(vps_data), Some(sps_data), Some(pps_data)) = (&self.pending_vps, &self.pending_sps, &self.pending_pps) {
            let (w, h) = parse_hevc_sps_dimensions(sps_data);
            self.video_codec_config = Some(VideoCodecConfig {
                codec: VideoCodec::Hevc,
                sps: sps_data.clone(),
                pps: pps_data.clone(),
                vps: Some(vps_data.clone()),
                width: w,
                height: h,
            });
        }
    }

    pub fn take_frames(&mut self) -> Vec<PesFrame> {
        std::mem::take(&mut self.frames)
    }

    pub fn has_pes_buffers(&self) -> bool {
        !self.pes_buffers.is_empty()
    }

    pub fn flush(&mut self) {
        let pids: Vec<u16> = self.pes_buffers.keys().copied().collect();
        for pid in pids {
            if let Some(buf) = self.pes_buffers.remove(&pid) {
                if !buf.is_empty() {
                    self.complete_pes(pid, &buf);
                }
            }
        }
    }

    pub fn video_codec_config(&self) -> Option<&VideoCodecConfig> {
        self.video_codec_config.as_ref()
    }

    pub fn audio_codec_config(&self) -> Option<&AudioCodecConfig> {
        self.audio_codec_config.as_ref()
    }

    pub fn stream_info(&self) -> Option<&TsStreamInfo> {
        self.stream_info.as_ref()
    }
}

fn detect_keyframe(data: &[u8], stream_type: u8) -> bool {
    let nals = split_nal_units_annex_b(data);
    for nal in &nals {
        if nal.is_empty() { continue; }
        match stream_type {
            H264_STREAM_TYPE => {
                let nal_type = nal[0] & 0x1F;
                if nal_type == H264_NAL_IDR { return true; }
            }
            HEVC_STREAM_TYPE => {
                let nal_type = (nal[0] >> 1) & 0x3F;
                if nal_type == HEVC_NAL_IDR_W || nal_type == HEVC_NAL_IDR_N { return true; }
            }
            _ => {}
        }
    }
    false
}

/// Split video ES data (Annex B format) into individual access units.
/// Many TS encoders set pusi=1 only at keyframes, so a single PES can contain
/// an entire GOP (multiple access units). This function splits them so each
/// gets its own PesFrame with incrementing PTS/DTS.
///
/// For H.264: AU boundary = AUD NAL (type 9) or first VCL NAL after non-VCL NALs.
/// For HEVC: AU boundary = AUD NAL (type 35) or first VCL NAL after non-VCL NALs.
fn split_video_access_units(data: &[u8], stream_type: u8) -> Vec<Vec<u8>> {
    let nals = split_nal_units_annex_b(data);
    if nals.is_empty() { return Vec::new(); }

    // Determine if a NAL is VCL (Video Coding Layer) — i.e., a slice/picture
    fn is_h264_vcl(nal_type: u8) -> bool { nal_type >= 1 && nal_type <= 5 }
    fn is_hevc_vcl(nal_type: u8) -> bool {
        // HEVC VCL NAL types: 0-9 (BLA, BLANT, BLA_W_LP, BLA_W_DLP, BLA_N_LP,
        // IDR_W_RADL, IDR_N_LP, CRA, CRA_NUT, RSV_IRAP) + 16-21 (RSV_VCL_*)
        nal_type <= 9 || (nal_type >= 16 && nal_type <= 21)
    }

    let mut access_units: Vec<Vec<u8>> = Vec::new();
    let mut current_au_nals: Vec<Vec<u8>> = Vec::new();
    let mut seen_vcl_in_current_au = false;

    for nal in nals {
        if nal.is_empty() { continue; }

        let is_new_au = match stream_type {
            H264_STREAM_TYPE => {
                let nal_type = nal[0] & 0x1F;
                if nal_type == H264_NAL_AUD {
                    // AUD always starts a new AU
                    true
                } else if is_h264_vcl(nal_type) && seen_vcl_in_current_au {
                    // VCL NAL after another VCL → new picture
                    true
                } else {
                    false
                }
            }
            HEVC_STREAM_TYPE => {
                let nal_type = (nal[0] >> 1) & 0x3F;
                if nal_type == 35 {
                    // HEVC AUD
                    true
                } else if is_hevc_vcl(nal_type) && seen_vcl_in_current_au {
                    true
                } else {
                    false
                }
            }
            _ => false,
        };

        if is_new_au && !current_au_nals.is_empty() {
            // Flush current AU and start new one
            let au_data = build_annex_b_from_nals(&current_au_nals);
            access_units.push(au_data);
            current_au_nals = Vec::new();
            seen_vcl_in_current_au = false;
        }

        // Skip AUD NALs — they're not needed in fMP4 (codec config handles framing)
        match stream_type {
            H264_STREAM_TYPE => {
                let nal_type = nal[0] & 0x1F;
                if nal_type == H264_NAL_AUD { continue; }
                if is_h264_vcl(nal_type) { seen_vcl_in_current_au = true; }
            }
            HEVC_STREAM_TYPE => {
                let nal_type = (nal[0] >> 1) & 0x3F;
                if nal_type == 35 { continue; }
                if is_hevc_vcl(nal_type) { seen_vcl_in_current_au = true; }
            }
            _ => {}
        }

        current_au_nals.push(nal);
    }

    // Flush the last AU
    if !current_au_nals.is_empty() {
        let au_data = build_annex_b_from_nals(&current_au_nals);
        access_units.push(au_data);
    }

    access_units
}

/// Reconstruct Annex B byte stream from individual NAL units.
fn build_annex_b_from_nals(nals: &[Vec<u8>]) -> Vec<u8> {
    let mut result = Vec::new();
    for (i, nal) in nals.iter().enumerate() {
        if i > 0 || true { // Always prepend start code
            result.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        }
        result.extend_from_slice(nal);
    }
    result
}

pub fn split_nal_units_annex_b(data: &[u8]) -> Vec<Vec<u8>> {
    let mut nals = Vec::new();
    let mut i = 0;
    let len = data.len();

    while i + 3 < len {
        if data[i] == 0 && data[i + 1] == 0 {
            let start_code_len = if i + 3 < len && data[i + 2] == 1 {
                3
            } else if i + 4 < len && data[i + 2] == 0 && data[i + 3] == 1 {
                4
            } else {
                i += 1;
                continue;
            };

            let nal_start = i + start_code_len;
            let mut nal_end = nal_start;

            while nal_end + 3 < len {
                if data[nal_end] == 0 && data[nal_end + 1] == 0
                    && (data[nal_end + 2] == 1 || (data[nal_end + 2] == 0 && nal_end + 4 < len && data[nal_end + 3] == 1))
                {
                    break;
                }
                nal_end += 1;
            }
            if nal_end + 3 >= len { nal_end = len; }

            if nal_start < nal_end {
                nals.push(data[nal_start..nal_end].to_vec());
            }
            i = nal_end;
        } else {
            i += 1;
        }
    }
    nals
}

pub fn annex_b_to_length_prefixed(data: &[u8]) -> Vec<u8> {
    let nals = split_nal_units_annex_b(data);
    let mut out = Vec::with_capacity(data.len());
    for nal in &nals {
        let len = nal.len() as u32;
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(nal);
    }
    out
}

fn extract_aac_frames(data: &[u8]) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    let mut offset = 0;
    while offset + 7 <= data.len() {
        if data[offset] != 0xFF || (data[offset + 1] & 0xF0) != 0xF0 { break; }

        let frame_length = (((data[offset + 3] & 0x03) as usize) << 11)
            | ((data[offset + 4] as usize) << 3)
            | ((data[offset + 5] as usize) >> 5);

        if frame_length < 7 || offset + frame_length > data.len() { break; }

        let header_size = if (data[offset + 1] & 0x01) != 0 { 7 } else { 9 };
        let raw_aac_start = offset + header_size;
        let raw_aac_len = frame_length - header_size;

        if raw_aac_start + raw_aac_len <= data.len() {
            frames.push(data[raw_aac_start..raw_aac_start + raw_aac_len].to_vec());
        }

        offset += frame_length;
    }
    frames
}

fn remove_emulation_prevention(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i + 2 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 3 {
            out.push(0);
            out.push(0);
            i += 3;
        } else {
            out.push(data[i]);
            i += 1;
        }
    }
    while i < data.len() {
        out.push(data[i]);
        i += 1;
    }
    out
}

fn parse_sps_dimensions(sps: &[u8]) -> (u32, u32) {
    if sps.len() < 4 { return (0, 0); }
    let rbsp = remove_emulation_prevention(&sps[1..]);
    let mut br = BitReader::new(&rbsp);
    let profile_idc = sps[1];

    br.skip(8 + 8 + 8);
    let _sps_id = br.read_ue().unwrap_or(0);

    if profile_idc == 100 || profile_idc == 110 || profile_idc == 122
        || profile_idc == 244 || profile_idc == 44 || profile_idc == 83
        || profile_idc == 86 || profile_idc == 118 || profile_idc == 128
        || profile_idc == 138 || profile_idc == 139 || profile_idc == 134
    {
        let chroma_format_idc = br.read_ue().unwrap_or(1);
        if chroma_format_idc == 3 { br.skip(1); }
        let _bit_depth_luma_minus8 = br.read_ue().unwrap_or(0);
        let _bit_depth_chroma_minus8 = br.read_ue().unwrap_or(0);
        let _qpprime_y_zero_transform_bypass = br.read_bit().unwrap_or(0);
        let seq_scaling_matrix_present = br.read_bit().unwrap_or(0);
        if seq_scaling_matrix_present != 0 {
            let num_lists = if chroma_format_idc != 3 { 8 } else { 12 };
            for i in 0..num_lists {
                let seq_scaling_list_present = br.read_bit().unwrap_or(0);
                if seq_scaling_list_present != 0 {
                    let size = if i < 6 { 16 } else { 64 };
                    let mut last_scale = 8i64;
                    let mut next_scale = 8i64;
                    for _ in 0..size {
                        if next_scale != 0 {
                            let delta = br.read_se().unwrap_or(0);
                            next_scale = (last_scale + delta + 256) % 256;
                        }
                        last_scale = if next_scale != 0 { next_scale } else { last_scale };
                    }
                }
            }
        }
    }

    let _log2_max_frame_num_minus4 = br.read_ue().unwrap_or(0);
    let pic_order_cnt_type = br.read_ue().unwrap_or(0);
    match pic_order_cnt_type {
        0 => { let _ = br.read_ue(); }
        1 => {
            let _delta_pic_order_always_zero = br.read_bit().unwrap_or(0);
            let _ = br.read_se();
            let _ = br.read_se();
            let n = br.read_ue().unwrap_or(0);
            for _ in 0..n { let _ = br.read_se(); }
        }
        _ => {}
    }

    let _max_num_ref_frames = br.read_ue().unwrap_or(0);
    let _gaps_in_frame_num = br.read_bit().unwrap_or(0);
    let pic_width_in_mbs_minus1 = br.read_ue().unwrap_or(0);
    let pic_height_in_map_units_minus1 = br.read_ue().unwrap_or(0);
    let frame_mbs_only = br.read_bit().unwrap_or(1);

    let width = ((pic_width_in_mbs_minus1 + 1) * 16) as u32;
    let height = ((pic_height_in_map_units_minus1 + 1) * 16 * (2 - frame_mbs_only as u64)) as u32;

    (width, height)
}

fn parse_hevc_sps_dimensions(_sps: &[u8]) -> (u32, u32) {
    (0, 0)
}

struct BitReader<'a> {
    data: &'a [u8],
    byte_offset: usize,
    bit_offset: u8,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, byte_offset: 0, bit_offset: 0 }
    }

    fn skip(&mut self, bits: usize) {
        self.byte_offset += (self.bit_offset as usize + bits) / 8;
        self.bit_offset = ((self.bit_offset as usize + bits) % 8) as u8;
    }

    fn read_bit(&mut self) -> Option<u8> {
        if self.byte_offset >= self.data.len() { return None; }
        let bit = (self.data[self.byte_offset] >> (7 - self.bit_offset)) & 1;
        self.bit_offset += 1;
        if self.bit_offset == 8 {
            self.bit_offset = 0;
            self.byte_offset += 1;
        }
        Some(bit)
    }

    fn read_ue(&mut self) -> Option<u64> {
        let mut leading_zeros = 0u8;
        while self.read_bit()? == 0 {
            leading_zeros += 1;
            if leading_zeros > 32 { return None; }
        }
        if leading_zeros == 0 { return Some(0); }
        let mut value = 1u64;
        for _ in 0..leading_zeros {
            value = (value << 1) | self.read_bit()? as u64;
        }
        Some(value - 1)
    }

    fn read_se(&mut self) -> Option<i64> {
        let ue = self.read_ue()?;
        if ue % 2 == 0 {
            Some(-(ue as i64) / 2)
        } else {
            Some((ue as i64 + 1) / 2)
        }
    }
}

/// State carried across chunk boundaries during keyframe scanning.
/// Keeps partially-assembled PES packets so that keyframes whose PES
/// data spans a chunk boundary are not lost.
pub struct KeyframeScanState {
    pes_buffers: HashMap<u16, Vec<u8>>,
    last_video_offset: u64,
}

impl Default for KeyframeScanState {
    fn default() -> Self {
        Self {
            pes_buffers: HashMap::new(),
            last_video_offset: 0,
        }
    }
}

/// Scan a chunk of TS data for video keyframes, carrying state across chunks.
///
/// This is the stateful version of `scan_keyframes`. Call it for each
/// consecutive chunk, passing the same `state` object, so that PES packets
/// spanning chunk boundaries are correctly assembled and their keyframes
/// detected.
///
/// `file_offset` is the byte position of this chunk within the original file
/// (used to report keyframe byte offsets).
pub fn scan_keyframes_chunked(
    data: &[u8],
    file_offset: u64,
    stream_info: &TsStreamInfo,
    state: &mut KeyframeScanState,
) -> Vec<(f64, u64)> {
    let mut keyframes = Vec::new();
    let mut offset = 0;

    while offset + TS_PACKET_SIZE <= data.len() {
        if data[offset] != TS_SYNC_BYTE {
            offset += 1;
            continue;
        }

        let pkt = &data[offset..offset + TS_PACKET_SIZE];
        let pid = ((pkt[1] as u16 & 0x1F) << 8) | pkt[2] as u16;
        let pusi = (pkt[1] >> 6) & 0x01;
        let afc = (pkt[3] >> 4) & 0x03;

        if pid != stream_info.video_pid {
            offset += TS_PACKET_SIZE;
            continue;
        }

        let mut payload_offset: usize = 4;
        if afc & 0x02 != 0 {
            if payload_offset >= TS_PACKET_SIZE { offset += TS_PACKET_SIZE; continue; }
            let af_len = pkt[payload_offset] as usize;
            payload_offset += 1 + af_len;
        }
        if afc & 0x01 == 0 { offset += TS_PACKET_SIZE; continue; }
        if payload_offset >= TS_PACKET_SIZE { offset += TS_PACKET_SIZE; continue; }

        let payload = &pkt[payload_offset..TS_PACKET_SIZE];

        if pusi == 1 {
            // A new PES starts — process the previous PES buffer for this PID
            if let Some(prev_buf) = state.pes_buffers.remove(&pid) {
                if !prev_buf.is_empty() && prev_buf.len() >= 9 {
                    if prev_buf[0] == 0x00 && prev_buf[1] == 0x00 && prev_buf[2] == 0x01 {
                        if let Some((pts, _, _)) = extract_pts_dts(&prev_buf) {
                            let header_data_length = prev_buf[8] as usize;
                            let es_offset = 9 + header_data_length;
                            if es_offset < prev_buf.len() {
                                let es_data = &prev_buf[es_offset..];
                                if detect_keyframe(es_data, stream_info.video_stream_type) {
                                    let time_s = pts as f64 / PTS_CLOCK_RATE as f64;
                                    keyframes.push((time_s, state.last_video_offset));
                                }
                            }
                        }
                    }
                }
            }
            state.pes_buffers.insert(pid, payload.to_vec());
            state.last_video_offset = file_offset + offset as u64;
        } else {
            if let Some(buf) = state.pes_buffers.get_mut(&pid) {
                buf.extend_from_slice(payload);
            }
        }

        offset += TS_PACKET_SIZE;
    }

    // NOTE: Do NOT flush remaining pes_buffers here — they may be completed
    // in the next chunk. The caller should use scan_keyframes_flush() after
    // all chunks have been processed.

    keyframes
}

/// Flush any remaining PES buffers at the end of keyframe scanning.
/// Call after all `scan_keyframes_chunked` calls to process the final PES.
pub fn scan_keyframes_flush(
    _file_offset: u64,
    stream_info: &TsStreamInfo,
    state: &mut KeyframeScanState,
) -> Vec<(f64, u64)> {
    let mut keyframes = Vec::new();
    for (pid, buf) in state.pes_buffers.drain() {
        if pid == stream_info.video_pid && buf.len() >= 9 && buf[0] == 0x00 && buf[1] == 0x00 && buf[2] == 0x01 {
            if let Some((pts, _, _)) = extract_pts_dts(&buf) {
                let header_data_length = buf[8] as usize;
                let es_offset = 9 + header_data_length;
                if es_offset < buf.len() {
                    let es_data = &buf[es_offset..];
                    if detect_keyframe(es_data, stream_info.video_stream_type) {
                        let time_s = pts as f64 / PTS_CLOCK_RATE as f64;
                        keyframes.push((time_s, state.last_video_offset));
                    }
                }
            }
        }
    }
    keyframes
}

pub fn scan_keyframes(data: &[u8], file_offset: u64, stream_info: &TsStreamInfo) -> Vec<(f64, u64)> {
    let mut state = KeyframeScanState::default();
    let mut result = scan_keyframes_chunked(data, file_offset, stream_info, &mut state);
    result.extend(scan_keyframes_flush(file_offset, stream_info, &mut state));
    result
}

/// Strip the 4-byte BDAV/M2TS prefix from each 192-byte packet, yielding plain
/// 188-byte TS. No-op when `is_m2ts` is false. Lives here (the TS parsing module)
/// so both server.rs and the download loops can share one implementation.
pub fn strip_m2ts_prefix(data: &[u8], is_m2ts: bool) -> Vec<u8> {
    if !is_m2ts {
        return data.to_vec();
    }
    let mut out = Vec::with_capacity(data.len() / 192 * 188);
    let mut offset = 0;
    while offset + 192 <= data.len() {
        // Verify sync byte (0x47) is at position 4 (after 4-byte BDAV prefix)
        if data[offset + 4] == 0x47 {
            out.extend_from_slice(&data[offset + 4..offset + 192]);
        }
        offset += 192;
    }
    out
}

/// Progressive keyframe index for one media file, built incrementally as the
/// background/proactive downloader sweeps bytes to disk. Shared via TelegramState
/// so the (Tauri-spawned) download task can WRITE it and the (Actix) hover
/// keyframe-lookup can READ it — the two live in different runtimes and can only
/// meet on the shared `Arc<TelegramState>`.
///
/// `samples` are (timestamp_s, byte_offset) keyframe positions kept sorted by
/// timestamp and de-duplicated. `covered_ranges` records which byte ranges have
/// already been scanned (so we don't re-scan). `total_size` guards against a
/// stale entry being read for a different file that reused the message_id.
#[derive(Debug, Clone, Default)]
pub struct KeyframeIndex {
    pub samples: Vec<(f64, u64)>,
    pub covered_ranges: Vec<(u64, u64)>,
    pub total_size: u64,
}

/// Merge freshly-scanned keyframe samples into an index, in place.
///
/// - `total_size` pins the entry to a file; a mismatch replaces the whole entry
///   (the previous samples belonged to a different file that reused the id).
/// - Samples are inserted in timestamp order; exact-duplicate timestamps are
///   skipped (idempotent — safe to call with overlapping scanned ranges, which
///   happens when both the bg-cache and proactive loops sweep the same file).
/// - `scanned_range` is appended to `covered_ranges` and coalesced.
///
/// Pure (no I/O) so it is fully unit-testable without a live download.
pub fn merge_keyframe_samples(
    index: &mut KeyframeIndex,
    total_size: u64,
    new_samples: &[(f64, u64)],
    scanned_range: (u64, u64),
) {
    // File identity guard: if the index was for a different-sized file (id reuse),
    // start fresh rather than mixing byte offsets from two files.
    if index.total_size != total_size {
        index.samples.clear();
        index.covered_ranges.clear();
        index.total_size = total_size;
    }

    for &(ts, off) in new_samples {
        // Insert sorted by timestamp; skip exact-duplicate timestamps.
        let pos = index.samples.partition_point(|(t, _)| *t < ts);
        if pos < index.samples.len() && index.samples[pos].0 == ts {
            continue;
        }
        index.samples.insert(pos, (ts, off));
    }

    if scanned_range.1 >= scanned_range.0 {
        index.covered_ranges.push(scanned_range);
        coalesce_ranges(&mut index.covered_ranges);
    }
}

/// Coalesce overlapping/adjacent (start,end) inclusive byte ranges in place.
/// Self-contained (ts_demux has no crate deps) so KeyframeIndex stays portable.
fn coalesce_ranges(ranges: &mut Vec<(u64, u64)>) {
    if ranges.len() < 2 {
        return;
    }
    ranges.sort_by_key(|r| r.0);
    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(ranges.len());
    for &(s, e) in ranges.iter() {
        if let Some(last) = merged.last_mut() {
            // Adjacent (last.1 + 1 == s) or overlapping → extend.
            if s <= last.1.saturating_add(1) {
                last.1 = last.1.max(e);
                continue;
            }
        }
        merged.push((s, e));
    }
    *ranges = merged;
}

/// Look up the nearest keyframe at or before `target_time_s` from an index,
/// but only if it is trustworthy for a hover at `approx_byte`:
/// - within 30s BEFORE the target time, and
/// - within one GOP (~4MB) of the linear-estimate byte.
///
/// These guards mirror the byte_time_cache fast path in server.rs: they stop a
/// sparse index (e.g. only head + tail scanned) from returning a keyframe far
/// from where the user is hovering. Returns (timestamp_s, byte_offset).
/// Pure + overflow-safe (abs_diff), so it is unit-testable.
pub fn lookup_keyframe(
    index: &KeyframeIndex,
    total_size: u64,
    target_time_s: f64,
    approx_byte: u64,
    max_time_behind_s: f64,
    max_byte_distance: u64,
) -> Option<(f64, u64)> {
    if index.total_size != total_size || index.samples.is_empty() {
        return None;
    }
    let idx = index.samples.partition_point(|(ts, _)| *ts <= target_time_s);
    if idx == 0 {
        return None;
    }
    let (ts, off) = index.samples[idx - 1];
    if target_time_s - ts <= max_time_behind_s && approx_byte.abs_diff(off) <= max_byte_distance {
        Some((ts, off))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ───────── Progressive keyframe index (hover-thumbnail) tests ─────────
    // These lock the pure logic behind the progressive index: merge/dedup,
    // range coalescing, file-identity guard, and the trust-window lookup.

    fn idx(total: u64) -> KeyframeIndex {
        KeyframeIndex { samples: Vec::new(), covered_ranges: Vec::new(), total_size: total }
    }

    #[test]
    fn t1_merge_inserts_sorted_and_dedups() {
        let mut i = idx(1000);
        merge_keyframe_samples(&mut i, 1000, &[(3.0, 300), (1.0, 100), (2.0, 200)], (100, 399));
        assert_eq!(i.samples, vec![(1.0, 100), (2.0, 200), (3.0, 300)]);
        // Re-merge overlapping (dup timestamps) — must not duplicate.
        merge_keyframe_samples(&mut i, 1000, &[(2.0, 200), (4.0, 400)], (200, 499));
        assert_eq!(i.samples, vec![(1.0, 100), (2.0, 200), (3.0, 300), (4.0, 400)]);
    }

    #[test]
    fn t2_covered_ranges_coalesce_adjacent_and_overlap() {
        let mut i = idx(1000);
        merge_keyframe_samples(&mut i, 1000, &[(1.0, 100)], (0, 199));
        merge_keyframe_samples(&mut i, 1000, &[(2.0, 200)], (200, 399)); // adjacent → merges
        assert_eq!(i.covered_ranges, vec![(0, 399)]);
        merge_keyframe_samples(&mut i, 1000, &[(5.0, 900)], (600, 799)); // gap → separate
        assert_eq!(i.covered_ranges, vec![(0, 399), (600, 799)]);
        merge_keyframe_samples(&mut i, 1000, &[(4.0, 500)], (300, 650)); // bridges → one range
        assert_eq!(i.covered_ranges, vec![(0, 799)]);
    }

    #[test]
    fn t3_total_size_mismatch_resets_entry() {
        let mut i = idx(1000);
        merge_keyframe_samples(&mut i, 1000, &[(1.0, 100), (2.0, 200)], (0, 399));
        // A different file reused the id (different size) → start fresh.
        merge_keyframe_samples(&mut i, 2000, &[(9.0, 900)], (800, 999));
        assert_eq!(i.total_size, 2000);
        assert_eq!(i.samples, vec![(9.0, 900)]);
        assert_eq!(i.covered_ranges, vec![(800, 999)]);
    }

    #[test]
    fn t4_lookup_within_time_and_byte_window_hits() {
        let mut i = idx(10_000);
        merge_keyframe_samples(&mut i, 10_000, &[(100.0, 5_000), (110.0, 5_500)], (0, 9999));
        // Hover at 112s, approx byte 5_600 → nearest <= is (110, 5500), within 30s + 4MB.
        let hit = lookup_keyframe(&i, 10_000, 112.0, 5_600, 30.0, 4 * 1024 * 1024);
        assert_eq!(hit, Some((110.0, 5_500)));
    }

    #[test]
    fn t5_lookup_rejects_far_byte_distance() {
        let mut i = idx(2_000_000_000);
        // Sample byte far from the hover's linear-estimate byte (> 4MB) → reject.
        merge_keyframe_samples(&mut i, 2_000_000_000, &[(100.0, 100_000_000)], (0, 200_000_000));
        let hit = lookup_keyframe(&i, 2_000_000_000, 110.0, 100_000_000 + 5 * 1024 * 1024, 30.0, 4 * 1024 * 1024);
        assert_eq!(hit, None);
    }

    #[test]
    fn t6_lookup_rejects_stale_time_distance() {
        let mut i = idx(10_000);
        merge_keyframe_samples(&mut i, 10_000, &[(100.0, 5_000)], (0, 9999));
        // Hover 140s but nearest keyframe is 100s → 40s behind > 30s → reject.
        let hit = lookup_keyframe(&i, 10_000, 140.0, 5_000, 30.0, 4 * 1024 * 1024);
        assert_eq!(hit, None);
    }

    #[test]
    fn t7_lookup_empty_index_is_none() {
        let i = idx(10_000);
        assert_eq!(lookup_keyframe(&i, 10_000, 50.0, 1000, 30.0, 4 * 1024 * 1024), None);
    }

    #[test]
    fn t8_lookup_target_before_first_sample_is_none() {
        let mut i = idx(10_000);
        merge_keyframe_samples(&mut i, 10_000, &[(100.0, 5_000)], (0, 9999));
        // Target 50s is BEFORE the first sample (100s) → partition_point idx==0 → None.
        assert_eq!(lookup_keyframe(&i, 10_000, 50.0, 5_000, 30.0, 4 * 1024 * 1024), None);
    }

    #[test]
    fn t9_lookup_overflow_safe_at_extremes() {
        let mut i = idx(u64::MAX);
        // Sample at byte 0; hover approx_byte at u64::MAX must not panic (abs_diff).
        merge_keyframe_samples(&mut i, u64::MAX, &[(10.0, 0)], (0, 100));
        assert_eq!(lookup_keyframe(&i, u64::MAX, 12.0, u64::MAX, 30.0, 4 * 1024 * 1024), None);
        // And a within-window hit at byte 0 works.
        assert_eq!(lookup_keyframe(&i, u64::MAX, 12.0, 10, 30.0, 4 * 1024 * 1024), Some((10.0, 0)));
    }

    #[test]
    fn t10_lookup_total_size_mismatch_is_none() {
        let mut i = idx(10_000);
        merge_keyframe_samples(&mut i, 10_000, &[(100.0, 5_000)], (0, 9999));
        // Caller's total_size disagrees with the index → treat as stale → None.
        assert_eq!(lookup_keyframe(&i, 9_999, 110.0, 5_000, 30.0, 4 * 1024 * 1024), None);
    }

    #[test]
    fn t11_strip_m2ts_prefix_yields_188_packets() {
        // Build two 192-byte M2TS packets (4-byte prefix + 0x47 + 187 bytes).
        let mut m2ts = Vec::new();
        for _ in 0..2 {
            m2ts.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // BDAV prefix
            m2ts.push(0x47);
            m2ts.extend_from_slice(&[0u8; 187]);
        }
        let stripped = strip_m2ts_prefix(&m2ts, true);
        assert_eq!(stripped.len(), 376); // 2 × 188
        assert_eq!(stripped[0], 0x47);
        assert_eq!(stripped[188], 0x47);
        // is_m2ts=false is a pass-through copy.
        assert_eq!(strip_m2ts_prefix(&[1, 2, 3], false), vec![1, 2, 3]);
    }

    #[test]
    fn t12_merge_ignores_empty_scanned_range() {
        // A degenerate (start>end) range must not be pushed.
        let mut i = idx(1000);
        merge_keyframe_samples(&mut i, 1000, &[(1.0, 100)], (500, 100));
        assert!(i.covered_ranges.is_empty());
        assert_eq!(i.samples, vec![(1.0, 100)]);
    }

    fn make_ts_packet(pid: u16, pusi: bool, payload: &[u8]) -> Vec<u8> {
        let mut pkt = vec![0u8; TS_PACKET_SIZE];
        pkt[0] = TS_SYNC_BYTE;
        pkt[1] = (if pusi { 0x40 } else { 0x00 }) | ((pid >> 8) & 0x1F) as u8;
        pkt[2] = (pid & 0xFF) as u8;
        pkt[3] = 0x10;
        let payload_len = payload.len().min(TS_PACKET_SIZE - 4);
        pkt[4..4 + payload_len].copy_from_slice(&payload[..payload_len]);
        pkt
    }

    fn make_pes_packet(stream_id: u8, pts: u64, dts: Option<u64>, es_data: &[u8]) -> Vec<u8> {
        let has_dts = dts.is_some();
        let pts_dts_flags: u8 = if has_dts { 0x03 } else { 0x02 };
        let header_data_len = if has_dts { 10 } else { 5 };
        let pes_data_len = 1 + 1 + header_data_len + es_data.len();
        let mut pes = Vec::new();
        pes.extend_from_slice(&[0x00, 0x00, 0x01]);
        pes.push(stream_id);
        let len = pes_data_len as u16;
        pes.extend_from_slice(&len.to_be_bytes());
        pes.push(0x80);
        pes.push(pts_dts_flags << 6);
        pes.push(header_data_len as u8);
        pes.extend_from_slice(&encode_33bit_timestamp(pts));
        if let Some(d) = dts {
            pes.extend_from_slice(&encode_33bit_timestamp(d));
        }
        pes.extend_from_slice(es_data);
        pes
    }

    fn encode_33bit_timestamp(ts: u64) -> [u8; 5] {
        let mut buf = [0u8; 5];
        buf[0] = 0x20 | (((ts >> 30) & 0x07) as u8) << 1 | 0x01;
        buf[1] = ((ts >> 22) & 0xFF) as u8;
        buf[2] = (((ts >> 15) & 0x7F) as u8) << 1 | 0x01;
        buf[3] = ((ts >> 7) & 0xFF) as u8;
        buf[4] = ((ts & 0x7F) as u8) << 1 | 0x01;
        buf
    }

    fn make_h264_idr_nal(width_mbs: u16, height_mbs: u16) -> Vec<u8> {
        let profile_idc: u8 = 100;
        let constraint_flags: u8 = 0x00;
        let level_idc: u8 = 40;
        let sps_id: u64 = 0;
        let chroma_format_idc: u64 = 1;
        let log2_max_frame_num_minus4: u64 = 0;
        let pic_order_cnt_type: u64 = 0;
        let log2_max_pic_order_cnt_lsb_minus4: u64 = 0;
        let max_num_ref_frames: u64 = 0;
        let gaps_in_frame_num: u64 = 0;
        let pic_width_in_mbs_minus1: u64 = width_mbs as u64 - 1;
        let pic_height_in_map_units_minus1: u64 = height_mbs as u64 - 1;
        let frame_mbs_only: u64 = 1;

        let mut br = BitWriter::new();
        br.write_bits(8, profile_idc as u64);
        br.write_bits(8, constraint_flags as u64);
        br.write_bits(8, level_idc as u64);
        br.write_ue(sps_id);
        br.write_ue(chroma_format_idc);
        br.write_ue(0); // bit_depth_luma_minus8
        br.write_ue(0); // bit_depth_chroma_minus8
        br.write_bit(0); // qpprime_y_zero_transform_bypass
        br.write_bit(0); // seq_scaling_matrix_present
        br.write_ue(log2_max_frame_num_minus4);
        br.write_ue(pic_order_cnt_type);
        br.write_ue(log2_max_pic_order_cnt_lsb_minus4);
        br.write_ue(max_num_ref_frames);
        br.write_bit(gaps_in_frame_num as u8);
        br.write_ue(pic_width_in_mbs_minus1);
        br.write_ue(pic_height_in_map_units_minus1);
        br.write_bit(frame_mbs_only as u8);
        br.flush();
        let sps_bits = br.bytes();

        let mut sps_nal = vec![0x64, constraint_flags, level_idc];
        sps_nal.extend_from_slice(&sps_bits);

        let pps_nal = vec![0x68, 0xCE, 0x38, 0x80];

        let idr_slice_data = vec![0x88u8, 0x84, 0x00, 0x04];

        let mut nals = Vec::new();
        nals.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        nals.extend_from_slice(&sps_nal);
        nals.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        nals.extend_from_slice(&pps_nal);
        nals.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        nals.push(0x65);
        nals.extend_from_slice(&idr_slice_data);
        nals
    }

    struct BitWriter {
        bytes: Vec<u8>,
        current_byte: u8,
        bit_pos: u8,
    }

    impl BitWriter {
        fn new() -> Self {
            BitWriter { bytes: Vec::new(), current_byte: 0, bit_pos: 0 }
        }

        fn write_bit(&mut self, bit: u8) {
            self.current_byte |= bit << (7 - self.bit_pos);
            self.bit_pos += 1;
            if self.bit_pos == 8 {
                self.bytes.push(self.current_byte);
                self.current_byte = 0;
                self.bit_pos = 0;
            }
        }

        fn write_bits(&mut self, count: u8, value: u64) {
            for i in (0..count).rev() {
                self.write_bit(((value >> i) & 1) as u8);
            }
        }

        fn write_ue(&mut self, mut value: u64) {
            value += 1;
            let leading_zeros = 64 - value.leading_zeros() as u8;
            for _ in 0..leading_zeros - 1 {
                self.write_bit(0);
            }
            for i in (0..leading_zeros).rev() {
                self.write_bit(((value >> i) & 1) as u8);
            }
        }

        fn flush(&mut self) {
            if self.bit_pos > 0 {
                self.bytes.push(self.current_byte);
                self.current_byte = 0;
                self.bit_pos = 0;
            }
        }

        fn bytes(self) -> Vec<u8> {
            self.bytes
        }
    }

    fn make_minimal_ts_stream() -> Vec<u8> {
        let pat_pid: u16 = 0x0000;
        let pmt_pid: u16 = 0x1000;
        let video_pid: u16 = 0x0100;
        let audio_pid: u16 = 0x0101;

        // PAT: program 1 → PMT PID 0x1000
        let pat_section: Vec<u8> = {
            let mut s = Vec::new();
            s.push(0x00); // table_id
            s.push(0xB0); // section_syntax_indicator=1, reserved
            s.push(0x0D); // section_length (remaining bytes after this)
            s.extend_from_slice(&0x0001u16.to_be_bytes()); // transport_stream_id
            s.push(0xC1); // reserved + version + current_next
            s.push(0x00); // section_number
            s.push(0x00); // last_section_number
            // Program entry: program_number=1, PMT PID
            s.extend_from_slice(&0x0001u16.to_be_bytes()); // program_number
            s.extend_from_slice(&((pmt_pid as u16) | 0xE000).to_be_bytes()); // reserved + PMT PID
            s.extend_from_slice(&0x2AB104u32.to_be_bytes()); // CRC32 placeholder
            s
        };

        let mut pat_pkt = vec![0u8; TS_PACKET_SIZE];
        pat_pkt[0] = TS_SYNC_BYTE;
        pat_pkt[1] = 0x40 | ((pat_pid >> 8) & 0x1F) as u8; // PUSI=1
        pat_pkt[2] = (pat_pid & 0xFF) as u8;
        pat_pkt[3] = 0x10; // no adaptation, payload only
        pat_pkt[4] = 0x00; // pointer_field
        let pat_data_len = pat_section.len().min(TS_PACKET_SIZE - 5);
        pat_pkt[5..5 + pat_data_len].copy_from_slice(&pat_section[..pat_data_len]);

        // PMT: program 1, video PID 0x0100 (H264), audio PID 0x0101 (AAC)
        let pmt_section: Vec<u8> = {
            let mut s = Vec::new();
            s.push(0x02); // table_id
            s.push(0xB0); // section_syntax_indicator=1
            s.push(0x17); // section_length (9 header + 5 video + 5 audio + 4 CRC = 23)
            s.extend_from_slice(&0x0001u16.to_be_bytes()); // program_number
            s.push(0xC1); // reserved + version + current_next
            s.push(0x00); // section_number
            s.push(0x00); // last_section_number
            s.extend_from_slice(&0xE100u16.to_be_bytes()); // PCR PID = video_pid
            s.extend_from_slice(&0xF000u16.to_be_bytes()); // program_info_length=0
            // Video stream: H264 (0x1B) at PID 0x0100
            s.push(0x1B); // stream_type
            s.extend_from_slice(&((video_pid as u16) | 0xE000).to_be_bytes()); // ES PID
            s.extend_from_slice(&0xF000u16.to_be_bytes()); // ES info length=0
            // Audio stream: AAC (0x0F) at PID 0x0101
            s.push(0x0F); // stream_type
            s.extend_from_slice(&((audio_pid as u16) | 0xE000).to_be_bytes()); // ES PID
            s.extend_from_slice(&0xF000u16.to_be_bytes()); // ES info length=0
            s.extend_from_slice(&0x2F2D4E07u32.to_be_bytes()); // CRC32 placeholder
            s
        };

        let mut pmt_pkt = vec![0u8; TS_PACKET_SIZE];
        pmt_pkt[0] = TS_SYNC_BYTE;
        pmt_pkt[1] = 0x40 | ((pmt_pid >> 8) & 0x1F) as u8; // PUSI=1
        pmt_pkt[2] = (pmt_pid & 0xFF) as u8;
        pmt_pkt[3] = 0x10;
        pmt_pkt[4] = 0x00; // pointer_field
        let pmt_data_len = pmt_section.len().min(TS_PACKET_SIZE - 5);
        pmt_pkt[5..5 + pmt_data_len].copy_from_slice(&pmt_section[..pmt_data_len]);

        let pts_1s: u64 = 90000;
        let video_es = make_h264_idr_nal(80, 45);
        let video_pes = make_pes_packet(0xE0, pts_1s, Some(pts_1s - 900), &video_es);

        let mut video_pkts = Vec::new();
        let mut pes_offset = 0;
        let mut first = true;
        while pes_offset < video_pes.len() {
            let chunk_end = (pes_offset + TS_PACKET_SIZE - 4).min(video_pes.len());
            let chunk = &video_pes[pes_offset..chunk_end];
            let mut pkt = vec![0u8; TS_PACKET_SIZE];
            pkt[0] = TS_SYNC_BYTE;
            pkt[1] = (if first { 0x40 } else { 0x00 }) | ((video_pid >> 8) & 0x1F) as u8;
            pkt[2] = (video_pid & 0xFF) as u8;
            if chunk.len() < TS_PACKET_SIZE - 4 {
                let af_len = (TS_PACKET_SIZE - 5 - chunk.len()) as u8;
                pkt[3] = 0x30;
                pkt[4] = af_len;
                for i in (5 + af_len as usize)..TS_PACKET_SIZE {
                    pkt[i] = 0xFF;
                }
                let payload_start = 4 + 1 + af_len as usize;
                pkt[payload_start..payload_start + chunk.len()].copy_from_slice(chunk);
            } else {
                pkt[3] = 0x10;
                pkt[4..4 + chunk.len()].copy_from_slice(chunk);
            }
            first = false;
            video_pkts.push(pkt);
            pes_offset = chunk_end;
        }

        let audio_es = vec![0xFF, 0xF1, 0x50, 0x80, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        let audio_pes = make_pes_packet(0xC0, pts_1s, None, &audio_es);
        let audio_pkt = make_ts_packet(audio_pid, true, &audio_pes);

        let mut stream = Vec::new();
        stream.extend_from_slice(&pat_pkt);
        stream.extend_from_slice(&pmt_pkt);
        for pkt in video_pkts { stream.extend_from_slice(&pkt); }
        stream.extend_from_slice(&audio_pkt);
        stream
    }

    #[test]
    fn test_extract_stream_info() {
        let data = make_minimal_ts_stream();
        let info = extract_stream_info(&data);
        assert!(info.is_some(), "Should extract stream info from minimal TS");
        let si = info.unwrap();
        assert_eq!(si.video_pid, 0x0100, "Video PID should be 0x0100");
        assert_eq!(si.audio_pid, 0x0101, "Audio PID should be 0x0101");
        assert_eq!(si.video_stream_type, 0x1B, "Video stream type should be H264 (0x1B)");
        assert_eq!(si.audio_stream_type, 0x0F, "Audio stream type should be AAC (0x0F)");
    }

    #[test]
    fn test_demuxer_produces_frames() {
        let data = make_minimal_ts_stream();
        let info = extract_stream_info(&data).unwrap();
        let mut demuxer = TsDemuxer::new().with_stream_info(info);
        demuxer.feed(&data);
        demuxer.flush();
        let frames = demuxer.take_frames();
        assert!(!frames.is_empty(), "Demuxer should produce frames from minimal TS");
        let video_frames: Vec<_> = frames.iter().filter(|f| f.stream_type == 0x1B).collect();
        let audio_frames: Vec<_> = frames.iter().filter(|f| f.stream_type == 0x0F).collect();
        assert!(!video_frames.is_empty(), "Should have at least one video frame");
        assert!(!audio_frames.is_empty(), "Should have at least one audio frame");
    }

    #[test]
    fn test_video_keyframe_detection() {
        let data = make_minimal_ts_stream();
        let info = extract_stream_info(&data).unwrap();
        let mut demuxer = TsDemuxer::new().with_stream_info(info);
        demuxer.feed(&data);
        demuxer.flush();
        let frames = demuxer.take_frames();
        let video_keyframes: Vec<_> = frames.iter().filter(|f| f.stream_type == 0x1B && f.is_keyframe).collect();
        assert!(!video_keyframes.is_empty(), "First video frame should be a keyframe (IDR)");
    }

    #[test]
    fn test_pts_extraction() {
        let data = make_minimal_ts_stream();
        let info = extract_stream_info(&data).unwrap();
        let mut demuxer = TsDemuxer::new().with_stream_info(info);
        demuxer.feed(&data);
        demuxer.flush();
        let frames = demuxer.take_frames();
        let video_frame = frames.iter().find(|f| f.stream_type == 0x1B).unwrap();
        assert_eq!(video_frame.pts, 90000, "Video PTS should be 90000 (1 second at 90kHz)");
        assert!(video_frame.has_dts, "Video frame should have DTS");
    }

    #[test]
    fn test_extract_33bit_timestamp_roundtrip() {
        let mask = (1u64 << 33) - 1;
        let test_values: Vec<u64> = vec![0, 1, 90000, 90000 * 3600, mask];
        for ts in &test_values {
            let encoded = encode_33bit_timestamp(*ts);
            let decoded = extract_33bit_timestamp(&encoded);
            assert_eq!(decoded, *ts & mask, "Roundtrip failed for timestamp {}", ts);
        }
    }

    #[test]
    fn test_annex_b_to_length_prefixed() {
        let annex_b = vec![0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, 0x00, 0x00, 0x01, 0x68, 0xCE];
        let lp = annex_b_to_length_prefixed(&annex_b);
        assert_eq!(lp[0..4], [0x00, 0x00, 0x00, 0x03], "First NALU length should be 3");
        assert_eq!(lp[4], 0x65, "First NALU data should start with 0x65");
        assert_eq!(lp[7..11], [0x00, 0x00, 0x00, 0x02], "Second NALU length should be 2");
        assert_eq!(lp[11], 0x68, "Second NALU data should start with 0x68");
    }

    #[test]
    fn test_detect_keyframe_idr() {
        let idr_data = vec![0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84];
        assert!(detect_keyframe(&idr_data, H264_STREAM_TYPE), "IDR NAL should be detected as keyframe");
        let non_idr_data = vec![0x00, 0x00, 0x00, 0x01, 0x21, 0x88, 0x84];
        assert!(!detect_keyframe(&non_idr_data, H264_STREAM_TYPE), "Non-IDR NAL should not be detected as keyframe");
    }

    #[test]
    fn test_sps_dimensions_parsing() {
        let mut br = BitWriter::new();
        br.write_bits(8, 100u64); // profile_idc = High
        br.write_bits(8, 0u64);   // constraint_flags
        br.write_bits(8, 40u64);  // level_idc
        br.write_ue(0);           // seq_parameter_set_id
        br.write_ue(1);           // chroma_format_idc
        br.write_ue(0);           // bit_depth_luma_minus8
        br.write_ue(0);           // bit_depth_chroma_minus8
        br.write_bit(0);          // qpprime_y_zero_transform_bypass
        br.write_bit(0);          // seq_scaling_matrix_present
        br.write_ue(0);           // log2_max_frame_num_minus4
        br.write_ue(0);           // pic_order_cnt_type
        br.write_ue(0);           // log2_max_pic_order_cnt_lsb_minus4
        br.write_ue(0);           // max_num_ref_frames
        br.write_bit(0);          // gaps_in_frame_num
        br.write_ue(79);          // pic_width_in_mbs_minus1 (80 MBs = 1280px)
        br.write_ue(44);          // pic_height_in_map_units_minus1 (45 MBs = 720px)
        br.write_bit(1);          // frame_mbs_only
        br.flush();

        let sps_data = {
            let mut d = vec![0x64, 0x00, 0x28];
            d.extend_from_slice(&br.bytes());
            d
        };

        let (w, h) = parse_sps_dimensions(&sps_data);
        assert_eq!(w, 1280, "Width should be 1280 (80 MBs * 16)");
        assert_eq!(h, 720, "Height should be 720 (45 MBs * 16)");
    }

    #[test]
    fn test_adts_header_parsing() {
        let adts = vec![0xFF, 0xF1, 0x50, 0x80, 0x02, 0x00, 0x00];
        let config = parse_adts_header(&adts);
        assert!(config.is_some(), "Should parse valid ADTS header");
        let cfg = config.unwrap();
        assert_eq!(cfg.audio_object_type, 2, "AAC-LC object type should be 2");
        assert_eq!(cfg.sampling_freq, 44100, "Sampling freq should be 44100 Hz (index 4)");
        assert_eq!(cfg.channel_config, 2, "Channel config should be 2");
    }

    #[test]
    fn test_split_nal_units_annex_b() {
        let data = vec![
            0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00,
            0x00, 0x00, 0x01, 0x68, 0xCE,
            0x00, 0x00, 0x00, 0x01, 0x65, 0x88,
        ];
        let nals = split_nal_units_annex_b(&data);
        assert_eq!(nals.len(), 3, "Should find 3 NAL units");
        assert_eq!(nals[0][0], 0x67, "First NAL should be SPS (0x67)");
        assert_eq!(nals[1][0], 0x68, "Second NAL should be PPS (0x68)");
        assert_eq!(nals[2][0], 0x65, "Third NAL should be IDR (0x65)");
    }

    #[test]
    fn test_scan_keyframes() {
        let data = make_minimal_ts_stream();
        let info = extract_stream_info(&data).unwrap();
        let keyframes = scan_keyframes(&data, 0, &info);
        assert!(!keyframes.is_empty(), "Should find at least one keyframe");
        let (time_s, offset) = keyframes[0];
        assert!(time_s > 0.0, "Keyframe timestamp should be positive");
        assert!(offset > 0, "Keyframe byte offset should be past PAT/PMT packets");
    }

    #[test]
    fn test_emulation_prevention_removal() {
        let data = vec![0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x01, 0x42];
        let cleaned = remove_emulation_prevention(&data);
        assert_eq!(cleaned, vec![0x00, 0x00, 0x00, 0x00, 0x01, 0x42], "Emulation prevention bytes (00 00 03) should be removed");
    }

    #[test]
    fn test_pts_based_frame_slicing() {
        let pts_1s: u64 = 90000;
        let pts_5s: u64 = 5 * 90000;
        let target_duration = 5.0f64;

        let frames = vec![
            PesFrame { pts: pts_1s, dts: pts_1s, has_dts: true, is_keyframe: true, data: vec![0x65], stream_type: 0x1B },
            PesFrame { pts: pts_1s + 3600, dts: pts_1s + 3600, has_dts: true, is_keyframe: false, data: vec![0x21], stream_type: 0x1B },
            PesFrame { pts: pts_5s - 1000, dts: pts_5s - 1000, has_dts: true, is_keyframe: false, data: vec![0x21], stream_type: 0x1B },
            PesFrame { pts: pts_5s + 500, dts: pts_5s + 500, has_dts: true, is_keyframe: false, data: vec![0x21], stream_type: 0x1B },
            PesFrame { pts: pts_5s * 2, dts: pts_5s * 2, has_dts: true, is_keyframe: true, data: vec![0x65], stream_type: 0x1B },
        ];

        let first_video_pts = frames.iter()
            .filter(|f| f.stream_type == 0x1b)
            .map(|f| f.pts)
            .min()
            .unwrap();

        let target_end_pts = first_video_pts + (target_duration * PTS_CLOCK_RATE as f64) as u64;

        let kept: Vec<_> = frames.into_iter()
            .filter(|f| f.pts >= first_video_pts && f.pts < target_end_pts + PTS_CLOCK_RATE / 2)
            .collect();

        assert_eq!(kept.len(), 4, "Should keep 4 frames within 5s window (plus half-second margin)");
        assert!(kept.iter().all(|f| f.pts < pts_5s * 2), "Should not include frame at 10s");

        let actual_dur = (kept.last().unwrap().pts - first_video_pts) as f64 / PTS_CLOCK_RATE as f64;
        assert!(actual_dur <= target_duration + 0.5, "Actual duration {:.3}s should be within 0.5s of target {:.1}s", actual_dur, target_duration);
        assert!(actual_dur >= target_duration - 1.0, "Actual duration {:.3}s should be close to target {:.1}s", actual_dur, target_duration);
    }
}
