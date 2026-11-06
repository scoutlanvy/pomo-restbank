use std::{
    collections::BTreeMap,
    io::Cursor,
    path::{Path, PathBuf},
};
pub struct Audio {
    dir: tempfile::TempDir,
    alarm: PathBuf,
    ticks: BTreeMap<u16, PathBuf>,
    pub alarm_id: Option<uuid::Uuid>,
    pub tick_sequence: Option<u64>,
    pub running: bool,
}
impl Audio {
    pub fn cleanup(&mut self) {
        self.stop();
        // This is exclusively our own randomly named TempDir, never a user path.
        let _ = std::fs::remove_dir_all(self.dir.path());
        self.ticks.clear();
    }
    pub fn new() -> anyhow::Result<Self> {
        let dir = tempfile::Builder::new()
            .prefix("pomo-restbank-audio-")
            .tempdir()?;
        let alarm = dir.path().join("alarm.wav");
        std::fs::write(&alarm, include_bytes!("../assets/alarm.wav"))?;
        Ok(Self {
            dir,
            alarm,
            ticks: BTreeMap::new(),
            alarm_id: None,
            tick_sequence: None,
            running: false,
        })
    }
    pub fn prepare(&mut self, volume: u16) -> anyhow::Result<PathBuf> {
        anyhow::ensure!(volume <= 400, "Invalid tick volume");
        if let Some(path) = self.ticks.get(&volume) {
            return Ok(path.clone());
        }
        let mut source = hound::WavReader::new(Cursor::new(include_bytes!("../assets/tick.wav")))?;
        let spec = source.spec();
        anyhow::ensure!(
            spec.bits_per_sample == 16 && spec.sample_format == hound::SampleFormat::Int,
            "Expected PCM16 tick"
        );
        let path = self.dir.path().join(format!("tick-{volume}.wav"));
        let mut output = hound::WavWriter::create(&path, spec)?;
        for sample in source.samples::<i16>() {
            let scaled = (i32::from(sample?) * i32::from(volume) / 100)
                .clamp(i16::MIN.into(), i16::MAX.into());
            output.write_sample(scaled as i16)?;
        }
        output.finalize()?;
        self.ticks.insert(volume, path.clone());
        Ok(path)
    }
    pub fn stop(&mut self) {
        play(None, false);
        self.running = false;
    }
    pub fn update(
        &mut self,
        snapshot: &restbank_protocol::Snapshot,
        initial: bool,
    ) -> anyhow::Result<()> {
        use restbank_domain::Status;
        let s = &snapshot.state;
        let path = self.prepare(s.settings.tick_volume)?;
        if snapshot.storage_error.is_some() {
            self.stop();
            self.tick_sequence = Some(s.tick_sequence);
            return Ok(());
        }
        if s.status == Status::Alarm {
            if !initial && s.alarm_id != self.alarm_id {
                play(Some(&self.alarm), true);
            }
            self.alarm_id = s.alarm_id;
            self.running = false;
        } else {
            if self.alarm_id.take().is_some() {
                self.stop();
            }
            let running = s.status == Status::Running;
            if running
                && s.settings.tick_sound
                && s.settings.tick_volume > 0
                && !initial
                && (!self.running || self.tick_sequence != Some(s.tick_sequence))
            {
                play(Some(&path), false);
            }
            if !running && self.running {
                self.stop();
            }
            self.running = running;
        }
        self.tick_sequence = Some(s.tick_sequence);
        Ok(())
    }
}
impl Drop for Audio {
    fn drop(&mut self) {
        self.stop();
    }
}
#[cfg(windows)]
fn play(path: Option<&Path>, looping: bool) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Media::Audio::PlaySoundW;
    let path: Option<Vec<u16>> = path.map(|p| p.as_os_str().encode_wide().chain(Some(0)).collect());
    // PlaySound copies the filename before returning; WAV files live for this Audio's lifetime.
    unsafe {
        PlaySoundW(
            path.as_ref().map_or(std::ptr::null(), |p| p.as_ptr()),
            std::ptr::null_mut(),
            if path.is_some() {
                0x20000 | 1 | 2 | if looping { 8 } else { 0 }
            } else {
                0
            },
        );
    }
}
#[cfg(not(windows))]
fn play(_path: Option<&Path>, _looping: bool) {}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scaling_preserves_sample_count_and_amplifies_only_tick() {
        let mut audio = Audio::new().unwrap();
        let path = audio.prepare(400).unwrap();
        assert_eq!(audio.prepare(400).unwrap(), path);
        let mut original =
            hound::WavReader::new(Cursor::new(include_bytes!("../assets/tick.wav"))).unwrap();
        let mut amplified = hound::WavReader::open(path).unwrap();
        let a: Vec<_> = original.samples::<i16>().map(Result::unwrap).collect();
        let b: Vec<_> = amplified.samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(a.len(), b.len());
        assert_eq!(original.spec(), amplified.spec());
        for (a, b) in a.iter().zip(b) {
            assert_eq!(b, (i32::from(*a) * 4).clamp(-32768, 32767) as i16);
        }
        let muted = audio.prepare(0).unwrap();
        assert!(
            hound::WavReader::open(muted)
                .unwrap()
                .samples::<i16>()
                .all(|s| s.unwrap() == 0)
        );
        assert!(audio.prepare(401).is_err());
    }
    #[test]
    fn generated_audio_directory_is_removed_on_drop() {
        let path = {
            let audio = Audio::new().unwrap();
            audio.dir.path().to_path_buf()
        };
        assert!(!path.exists());
    }
}
