//! Deterministic timer rules. No wall clock, network, UI, or persistence.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Manual,
    Pomodoro,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Manual,
    Focus,
    Break,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Idle,
    Running,
    Paused,
    Choice,
    Alarm,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Shared,
    PerSubject,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub focus_scope: Scope,
    pub tick_sound: bool,
    pub tick_volume: u16,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Timer {
    pub session_id: Uuid,
    pub phase: Phase,
    pub total_seconds: u32,
    pub remaining_seconds: u32,
    pub subject: String,
    pub return_to_choice: bool,
    pub suspended_focus: Option<Box<Timer>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    pub session_id: Uuid,
    pub subject: String,
    pub duration_seconds: u32,
    pub mode: Mode,
    pub recorded_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct State {
    pub revision: u64,
    pub tick_sequence: u64,
    pub mode: Mode,
    pub subject: String,
    pub status: Status,
    pub timer: Option<Timer>,
    pub balance_seconds: u64,
    pub cycle_position: u8,
    pub shared_progress: u32,
    pub per_subject_progress: BTreeMap<String, u32>,
    pub settings: Settings,
    pub subjects: Vec<String>,
    pub focus_seconds: u32,
    pub short_break: u32,
    pub long_break: u32,
    pub alarm_id: Option<Uuid>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    Select {
        mode: Mode,
        subject: String,
    },
    Start {
        seconds: u32,
    },
    Pause,
    Resume,
    Reset,
    ContinueFocus,
    StartBreak {
        seconds: u32,
    },
    SkipBreak,
    StopAlarm,
    SaveSettings {
        focus_scope: Scope,
        tick_sound: bool,
        tick_volume: u16,
    },
    AddSubject {
        name: String,
    },
    DeleteSubject {
        name: String,
    },
    RetryStorage,
}

impl State {
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.focus_seconds, 10 | 1500)
            || self.cycle_position > 3
            || self.shared_progress >= self.focus_seconds
            || self.settings.tick_volume > 400
            || self
                .per_subject_progress
                .values()
                .any(|v| *v >= self.focus_seconds)
            || !self.subjects.iter().any(|s| s == "Umum")
            || !self.subjects.contains(&self.subject)
        {
            return Err("Invalid saved workspace; refusing to overwrite it.".into());
        }
        if matches!(
            self.status,
            Status::Running | Status::Paused | Status::Alarm
        ) && self.timer.is_none()
        {
            return Err("Saved timer is missing.".into());
        }
        if let Some(t) = &self.timer {
            if t.total_seconds == 0
                || t.remaining_seconds > t.total_seconds
                || (self.status != Status::Alarm && t.remaining_seconds == 0)
                || (t.phase == Phase::Focus && t.total_seconds > self.focus_seconds)
                || (t.phase == Phase::Break
                    && u64::from(t.remaining_seconds) > self.balance_seconds)
            {
                return Err("Invalid saved timer.".into());
            }
            if let Some(focus) = &t.suspended_focus
                && (t.phase != Phase::Break
                    || focus.phase != Phase::Focus
                    || focus.remaining_seconds == 0
                    || focus.remaining_seconds > focus.total_seconds
                    || focus.total_seconds > self.focus_seconds
                    || focus.suspended_focus.is_some())
            {
                return Err("Invalid saved suspended focus.".into());
            }
        }
        Ok(())
    }
    pub fn new(preview: bool) -> Self {
        Self {
            revision: 0,
            tick_sequence: 0,
            mode: Mode::Pomodoro,
            subject: "Umum".into(),
            status: Status::Idle,
            timer: None,
            balance_seconds: 0,
            cycle_position: 0,
            shared_progress: 0,
            per_subject_progress: BTreeMap::new(),
            settings: Settings {
                focus_scope: Scope::Shared,
                tick_sound: false,
                tick_volume: 100,
            },
            subjects: [
                "Umum",
                "Anki",
                "English",
                "Linux",
                "Programming",
                "System Admin",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            focus_seconds: if preview { 10 } else { 1500 },
            short_break: if preview { 5 } else { 300 },
            long_break: if preview { 15 } else { 900 },
            alarm_id: None,
        }
    }
    pub fn progress(&self, subject: &str) -> u32 {
        match self.settings.focus_scope {
            Scope::Shared => self.shared_progress,
            Scope::PerSubject => *self.per_subject_progress.get(subject).unwrap_or(&0),
        }
    }
    pub fn target_progress(&self) -> u32 {
        let focus = self.timer.as_ref().and_then(|t| {
            if t.phase == Phase::Focus {
                Some(t)
            } else {
                t.suspended_focus.as_deref()
            }
        });
        focus.filter(|t| t.remaining_seconds > 0).map_or_else(
            || self.progress(&self.subject),
            |t| self.focus_seconds - t.remaining_seconds,
        )
    }
    fn set_progress(&mut self, subject: &str, value: u32) {
        match self.settings.focus_scope {
            Scope::Shared => self.shared_progress = value,
            Scope::PerSubject => {
                self.per_subject_progress.insert(subject.into(), value);
            }
        }
    }
    fn require_idle(&self) -> Result<(), String> {
        if self.status == Status::Idle {
            Ok(())
        } else {
            Err("Finish or Reset the timer first.".into())
        }
    }
    fn new_timer(&self, phase: Phase, seconds: u32, return_to_choice: bool) -> Timer {
        Timer {
            session_id: Uuid::new_v4(),
            phase,
            total_seconds: seconds,
            remaining_seconds: seconds,
            subject: self.subject.clone(),
            return_to_choice,
            suspended_focus: None,
        }
    }
    fn begin_focus(&mut self) {
        let seconds = self.focus_seconds - self.progress(&self.subject);
        self.timer = Some(self.new_timer(Phase::Focus, seconds, true));
        self.status = Status::Running;
    }
    fn award(&mut self, subject: &str) {
        self.set_progress(subject, 0);
        self.balance_seconds += u64::from(if self.cycle_position == 3 {
            self.long_break
        } else {
            self.short_break
        });
        self.cycle_position = (self.cycle_position + 1) % 4;
    }
    fn session(timer: &Timer, seconds: u32, now: &str) -> Session {
        Session {
            session_id: timer.session_id,
            subject: timer.subject.clone(),
            duration_seconds: seconds,
            mode: if timer.phase == Phase::Manual {
                Mode::Manual
            } else {
                Mode::Pomodoro
            },
            recorded_at: now.into(),
        }
    }
    fn leave_break(&mut self, skipped: bool) {
        if let Some(timer) = self.timer.take() {
            if let Some(focus) = timer.suspended_focus {
                self.subject = focus.subject.clone();
                self.timer = Some(*focus);
                self.status = Status::Paused;
            } else {
                self.status = if skipped || timer.return_to_choice {
                    Status::Choice
                } else {
                    Status::Idle
                };
            }
        }
    }
    pub fn recover(&mut self) {
        if self.status == Status::Alarm {
            self.acknowledge_alarm();
        }
        if self.status == Status::Running {
            self.status = Status::Paused;
        }
        self.alarm_id = None;
        self.revision += 1;
    }
    fn acknowledge_alarm(&mut self) {
        self.alarm_id = None;
        match self.timer.as_ref().map(|t| t.phase) {
            Some(Phase::Focus) => {
                self.timer = None;
                self.status = Status::Choice;
            }
            Some(Phase::Break) => self.leave_break(false),
            _ => {
                self.timer = None;
                self.status = Status::Idle;
            }
        }
    }
    /// Call on a cloned candidate, then persist it atomically with returned sessions.
    pub fn apply(&mut self, command: &Command, now: &str) -> Result<Vec<Session>, String> {
        let mut sessions = Vec::new();
        match command {
            Command::Select { mode, subject } => {
                self.require_idle()?;
                if !self.subjects.contains(subject) {
                    return Err("Unknown subject.".into());
                }
                self.mode = *mode;
                self.subject = subject.clone();
            }
            Command::Start { seconds } => {
                self.require_idle()?;
                if self.mode == Mode::Pomodoro {
                    self.begin_focus();
                } else {
                    if !(1..=359999).contains(seconds) {
                        return Err("Enter a duration from 00:00:01 to 99:59:59.".into());
                    }
                    self.timer = Some(self.new_timer(Phase::Manual, *seconds, false));
                    self.status = Status::Running;
                }
            }
            Command::Pause => {
                if self.status != Status::Running {
                    return Err("Timer is not running.".into());
                }
                self.status = Status::Paused;
            }
            Command::Resume => {
                if self.status != Status::Paused {
                    return Err("Timer is not paused.".into());
                }
                self.status = Status::Running;
            }
            Command::Reset => {
                let focus = self
                    .timer
                    .as_ref()
                    .and_then(|t| {
                        if t.phase == Phase::Focus {
                            Some(t)
                        } else {
                            t.suspended_focus.as_deref()
                        }
                    })
                    .cloned();
                if let Some(focus) = focus {
                    // Completed targets have already been recorded before the alarm.
                    let elapsed = focus.total_seconds - focus.remaining_seconds;
                    if elapsed > 0 && focus.remaining_seconds > 0 {
                        sessions.push(Self::session(&focus, elapsed, now));
                        self.set_progress(&focus.subject, self.progress(&focus.subject) + elapsed);
                    }
                }
                self.timer = None;
                self.status = Status::Idle;
                self.alarm_id = None;
            }
            Command::ContinueFocus => {
                if self.status != Status::Choice {
                    return Err("No next-session choice is available.".into());
                }
                self.begin_focus();
            }
            Command::StartBreak { seconds } => {
                if self.mode != Mode::Pomodoro {
                    return Err("Breaks require Pomodoro mode.".into());
                }
                let suspended = self.status == Status::Paused
                    && self.timer.as_ref().is_some_and(|t| t.phase == Phase::Focus);
                if !suspended && !matches!(self.status, Status::Idle | Status::Choice) {
                    return Err("Pause focus before starting a break.".into());
                }
                if *seconds == 0 || u64::from(*seconds) > self.balance_seconds {
                    return Err("Choose a duration within the available break balance.".into());
                }
                let mut timer =
                    self.new_timer(Phase::Break, *seconds, self.status == Status::Choice);
                if suspended {
                    timer.suspended_focus = self.timer.take().map(Box::new);
                }
                self.timer = Some(timer);
                self.status = Status::Running;
            }
            Command::SkipBreak => {
                if self.status != Status::Running
                    || !self.timer.as_ref().is_some_and(|t| t.phase == Phase::Break)
                {
                    return Err("Only running breaks can be skipped.".into());
                }
                self.leave_break(true);
            }
            Command::StopAlarm => {
                if self.status != Status::Alarm {
                    return Err("No alarm is active.".into());
                }
                self.acknowledge_alarm();
            }
            Command::SaveSettings {
                focus_scope,
                tick_sound,
                tick_volume,
            } => {
                self.require_idle()?;
                if *tick_volume > 400 {
                    return Err("Tick volume must be 0–400%.".into());
                }
                self.settings = Settings {
                    focus_scope: *focus_scope,
                    tick_sound: *tick_sound,
                    tick_volume: *tick_volume,
                };
            }
            Command::AddSubject { name } => {
                self.require_idle()?;
                let name = name.trim();
                if name.is_empty() || name.chars().count() > 100 {
                    return Err("Enter a subject name of 1–100 characters.".into());
                }
                if let Some(existing) = self
                    .subjects
                    .iter()
                    .find(|s| s.to_lowercase() == name.to_lowercase())
                {
                    self.subject = existing.clone();
                } else {
                    self.subjects.push(name.into());
                    self.subject = name.into();
                }
            }
            Command::DeleteSubject { name } => {
                self.require_idle()?;
                if name.eq_ignore_ascii_case("Umum") {
                    return Err("Umum cannot be deleted.".into());
                }
                if !self.subjects.contains(name) {
                    return Err("Unknown subject.".into());
                }
                self.subjects.retain(|s| s != name);
                self.subject = "Umum".into();
            }
            Command::RetryStorage => return Err("Storage retry is handled by the server.".into()),
        }
        self.revision += 1;
        Ok(sessions)
    }
    pub fn tick(&mut self, now: &str) -> Vec<Session> {
        if self.status != Status::Running {
            return Vec::new();
        }
        let Some(timer) = self.timer.as_mut() else {
            return Vec::new();
        };
        if timer.remaining_seconds == 0 {
            return Vec::new();
        }
        timer.remaining_seconds -= 1;
        self.tick_sequence += 1;
        if timer.phase == Phase::Break {
            self.balance_seconds = self.balance_seconds.saturating_sub(1);
        }
        if timer.remaining_seconds > 0 {
            return Vec::new();
        }
        let timer = timer.clone();
        let mut sessions = Vec::new();
        if timer.phase != Phase::Break {
            sessions.push(Self::session(&timer, timer.total_seconds, now));
            if timer.phase == Phase::Focus {
                self.award(&timer.subject);
            }
        }
        self.status = Status::Alarm;
        self.alarm_id = Some(Uuid::new_v4());
        self.revision += 1;
        sessions
    }
}
