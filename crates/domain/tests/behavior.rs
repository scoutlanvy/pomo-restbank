use restbank_domain::*;
const NOW: &str = "2026-11-07T10:00:00+00:00";
fn run(s: &mut State, seconds: u32) -> Vec<Session> {
    (0..seconds).flat_map(|_| s.tick(NOW)).collect()
}
fn apply(s: &mut State, command: Command) -> Vec<Session> {
    s.apply(&command, NOW).unwrap()
}
fn focus(s: &mut State) -> Vec<Session> {
    if s.status == Status::Choice {
        apply(s, Command::ContinueFocus);
    } else {
        apply(s, Command::Start { seconds: 0 });
    }
    run(s, s.timer.as_ref().unwrap().remaining_seconds)
}
#[test]
fn rewards_repeat_and_never_duplicate_during_alarm() {
    let mut s = State::new(false);
    for balance in [300, 600, 900, 1800, 2100] {
        let sessions = focus(&mut s);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].duration_seconds, 1500);
        assert_eq!(s.balance_seconds, balance);
        assert_eq!(s.status, Status::Alarm);
        assert!(run(&mut s, 20).is_empty());
        assert_eq!(s.balance_seconds, balance);
        apply(&mut s, Command::StopAlarm);
        assert_eq!(s.status, Status::Choice);
    }
}
#[test]
fn reset_segments_complete_shared_target_across_subjects() {
    let mut s = State::new(false);
    apply(&mut s, Command::Start { seconds: 0 });
    run(&mut s, 600);
    let first = apply(&mut s, Command::Reset);
    assert_eq!(first[0].duration_seconds, 600);
    assert_eq!(s.shared_progress, 600);
    assert_eq!(s.balance_seconds, 0);
    apply(
        &mut s,
        Command::Select {
            mode: Mode::Pomodoro,
            subject: "English".into(),
        },
    );
    apply(&mut s, Command::Start { seconds: 0 });
    assert_eq!(s.timer.as_ref().unwrap().total_seconds, 900);
    let second = run(&mut s, 900);
    assert_eq!(second[0].duration_seconds, 900);
    assert_eq!(second[0].subject, "English");
    assert_eq!(s.shared_progress, 0);
    assert_eq!(s.balance_seconds, 300);
    assert!(apply(&mut s, Command::Reset).is_empty());
    assert_eq!(s.balance_seconds, 300);
}
#[test]
fn manual_reset_discards_and_completion_records_original_duration() {
    let mut s = State::new(false);
    apply(
        &mut s,
        Command::Select {
            mode: Mode::Manual,
            subject: "Umum".into(),
        },
    );
    apply(&mut s, Command::Start { seconds: 100 });
    run(&mut s, 30);
    apply(&mut s, Command::Pause);
    assert!(run(&mut s, 50).is_empty());
    assert_eq!(s.timer.as_ref().unwrap().remaining_seconds, 70);
    s.recover();
    apply(&mut s, Command::Resume);
    let sessions = run(&mut s, 70);
    assert_eq!(sessions[0].duration_seconds, 100);
    assert_eq!(s.balance_seconds, 0);
    apply(&mut s, Command::StopAlarm);
    assert_eq!(s.status, Status::Idle);
    apply(&mut s, Command::Start { seconds: 100 });
    run(&mut s, 20);
    assert!(apply(&mut s, Command::Reset).is_empty());
}
#[test]
fn break_debits_only_running_seconds_and_restores_focus_paused() {
    let mut s = State::new(false);
    s.balance_seconds = 50;
    apply(&mut s, Command::Start { seconds: 0 });
    run(&mut s, 100);
    apply(&mut s, Command::Pause);
    let id = s.timer.as_ref().unwrap().session_id;
    apply(&mut s, Command::StartBreak { seconds: 20 });
    run(&mut s, 5);
    assert_eq!(s.balance_seconds, 45);
    apply(&mut s, Command::Pause);
    run(&mut s, 20);
    assert_eq!(s.balance_seconds, 45);
    assert!(s.apply(&Command::SkipBreak, NOW).is_err());
    apply(&mut s, Command::Resume);
    run(&mut s, 15);
    assert_eq!(s.balance_seconds, 30);
    assert_eq!(s.status, Status::Alarm);
    apply(&mut s, Command::StopAlarm);
    assert_eq!(s.status, Status::Paused);
    assert_eq!(s.timer.as_ref().unwrap().session_id, id);
    assert_eq!(s.timer.as_ref().unwrap().remaining_seconds, 1400);
}
#[test]
fn reset_during_break_records_only_suspended_focus() {
    let mut s = State::new(false);
    s.balance_seconds = 100;
    apply(&mut s, Command::Start { seconds: 0 });
    run(&mut s, 80);
    apply(&mut s, Command::Pause);
    apply(&mut s, Command::StartBreak { seconds: 30 });
    run(&mut s, 10);
    let records = apply(&mut s, Command::Reset);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].duration_seconds, 80);
    assert_eq!(s.balance_seconds, 90);
    assert_eq!(s.shared_progress, 80);
    assert!(apply(&mut s, Command::Reset).is_empty());
}
#[test]
fn skipped_break_preserves_balance_and_restores_correct_destination() {
    let mut s = State::new(false);
    s.balance_seconds = 30;
    apply(&mut s, Command::StartBreak { seconds: 20 });
    run(&mut s, 3);
    apply(&mut s, Command::SkipBreak);
    assert_eq!(s.balance_seconds, 27);
    assert_eq!(s.status, Status::Choice);
    apply(&mut s, Command::ContinueFocus);
    run(&mut s, 2);
    apply(&mut s, Command::Pause);
    apply(&mut s, Command::StartBreak { seconds: 10 });
    apply(&mut s, Command::SkipBreak);
    assert_eq!(s.status, Status::Paused);
    assert_eq!(s.timer.unwrap().remaining_seconds, 1498);
}
#[test]
fn idle_break_finishes_idle_and_cannot_overdraw() {
    let mut s = State::new(true);
    s.balance_seconds = 5;
    assert!(s.apply(&Command::StartBreak { seconds: 6 }, NOW).is_err());
    apply(&mut s, Command::StartBreak { seconds: 5 });
    run(&mut s, 5);
    assert_eq!(s.balance_seconds, 0);
    apply(&mut s, Command::StopAlarm);
    assert_eq!(s.status, Status::Idle);
}
#[test]
fn scopes_retain_independent_progress_and_cannot_change_mid_focus() {
    let mut s = State::new(false);
    apply(&mut s, Command::Start { seconds: 0 });
    run(&mut s, 100);
    apply(&mut s, Command::Reset);
    apply(
        &mut s,
        Command::SaveSettings {
            alarm_sound_seconds: None,
            manual_counts_toward_pomodoro: None,
            focus_scope: Scope::PerSubject,
            tick_sound: true,
            tick_volume: 400,
        },
    );
    assert_eq!(s.progress("Umum"), 0);
    apply(&mut s, Command::Start { seconds: 0 });
    run(&mut s, 30);
    assert!(
        s.apply(
            &Command::SaveSettings {
                alarm_sound_seconds: None,
                manual_counts_toward_pomodoro: None,
                focus_scope: Scope::Shared,
                tick_sound: false,
                tick_volume: 0
            },
            NOW
        )
        .is_err()
    );
    apply(&mut s, Command::Reset);
    assert_eq!(s.progress("Umum"), 30);
    apply(
        &mut s,
        Command::Select {
            mode: Mode::Pomodoro,
            subject: "Anki".into(),
        },
    );
    assert_eq!(s.progress("Anki"), 0);
    apply(
        &mut s,
        Command::SaveSettings {
            alarm_sound_seconds: None,
            manual_counts_toward_pomodoro: None,
            focus_scope: Scope::Shared,
            tick_sound: false,
            tick_volume: 0,
        },
    );
    assert_eq!(s.progress("Anki"), 100);
}
#[test]
fn subject_operations_keep_progress_and_protect_umum() {
    let mut s = State::new(false);
    apply(
        &mut s,
        Command::AddSubject {
            name: "  Algebra  ".into(),
        },
    );
    assert_eq!(s.subject, "Algebra");
    apply(
        &mut s,
        Command::AddSubject {
            name: "algebra".into(),
        },
    );
    assert_eq!(s.subject, "Algebra");
    assert_eq!(
        s.subjects
            .iter()
            .filter(|n| n.to_lowercase() == "algebra")
            .count(),
        1
    );
    s.per_subject_progress.insert("Algebra".into(), 100);
    apply(
        &mut s,
        Command::DeleteSubject {
            name: "Algebra".into(),
        },
    );
    assert_eq!(s.subject, "Umum");
    assert_eq!(s.per_subject_progress["Algebra"], 100);
    assert!(
        s.apply(
            &Command::DeleteSubject {
                name: "Umum".into()
            },
            NOW
        )
        .is_err()
    );
    assert!(
        s.apply(&Command::AddSubject { name: "  ".into() }, NOW)
            .is_err()
    );
}
#[test]
fn recovery_stops_alarms_without_awarding_again() {
    let mut s = State::new(true);
    focus(&mut s);
    assert_eq!(s.balance_seconds, 5);
    s.recover();
    assert_eq!(s.status, Status::Choice);
    assert_eq!(s.alarm_id, None);
    assert_eq!(s.balance_seconds, 5);
    apply(&mut s, Command::ContinueFocus);
    run(&mut s, 2);
    s.recover();
    assert_eq!(s.status, Status::Paused);
    assert_eq!(s.timer.unwrap().remaining_seconds, 8);
}
#[test]
fn invalid_operations_do_not_change_revision() {
    let mut s = State::new(false);
    let r = s.revision;
    for command in [
        Command::Pause,
        Command::Resume,
        Command::ContinueFocus,
        Command::StopAlarm,
        Command::StartBreak { seconds: 0 },
        Command::SkipBreak,
    ] {
        assert!(s.apply(&command, NOW).is_err());
        assert_eq!(s.revision, r);
    }
}
#[test]
fn paused_focus_target_includes_carried_and_current_segment() {
    let mut s = State::new(false);
    apply(&mut s, Command::Start { seconds: 0 });
    run(&mut s, 300);
    apply(&mut s, Command::Reset);
    apply(&mut s, Command::Start { seconds: 0 });
    run(&mut s, 90);
    assert_eq!(s.target_progress(), 390);
    apply(&mut s, Command::Pause);
    s.balance_seconds = 20;
    apply(&mut s, Command::StartBreak { seconds: 20 });
    assert_eq!(s.target_progress(), 390);
}

#[test]
fn manual_contribution_reset_completion_and_overflow() {
    let mut s = State::new(false);
    s.mode = Mode::Manual;
    s.settings.manual_counts_toward_pomodoro = true;
    apply(&mut s, Command::Start { seconds: 300 });
    assert!(apply(&mut s, Command::Reset).is_empty());
    apply(&mut s, Command::Start { seconds: 300 });
    run(&mut s, 120);
    let records = apply(&mut s, Command::Reset);
    assert_eq!(records[0].duration_seconds, 120);
    assert_eq!(records[0].mode, Mode::Manual);
    assert_eq!(s.shared_progress, 120);
    s.shared_progress = 1380;
    apply(&mut s, Command::Start { seconds: 300 });
    let records = run(&mut s, 300);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].duration_seconds, 300);
    assert_eq!(s.shared_progress, 180);
    assert_eq!(s.balance_seconds, 300);
    assert!(apply(&mut s, Command::Reset).is_empty());
    assert_eq!(s.balance_seconds, 300);
    s.mode = Mode::Pomodoro;
    apply(&mut s, Command::Start { seconds: 0 });
    assert_eq!(s.timer.as_ref().unwrap().remaining_seconds, 1320);
}

#[test]
fn manual_multiple_targets_scope_and_recovery() {
    let mut s = State::new(true);
    s.mode = Mode::Manual;
    s.settings.focus_scope = Scope::PerSubject;
    s.settings.manual_counts_toward_pomodoro = true;
    apply(&mut s, Command::Start { seconds: 43 });
    run(&mut s, 12);
    s = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
    s.recover();
    assert!(run(&mut s, 100).is_empty());
    apply(&mut s, Command::Resume);
    assert_eq!(run(&mut s, 31).len(), 1);
    assert_eq!(s.progress("Umum"), 3);
    assert_eq!(s.progress("English"), 0);
    assert_eq!(s.shared_progress, 0);
    assert_eq!(s.balance_seconds, 30);
    assert_eq!(s.cycle_position, 0);
    s.validate().unwrap();
}

#[test]
fn old_manual_data_defaults_off_and_legacy_settings_preserve_choice() {
    let mut s = State::new(false);
    s.mode = Mode::Manual;
    apply(&mut s, Command::Start { seconds: 300 });
    let mut json = serde_json::to_value(&s).unwrap();
    json["settings"]
        .as_object_mut()
        .unwrap()
        .remove("manual_counts_toward_pomodoro");
    json["timer"]
        .as_object_mut()
        .unwrap()
        .remove("counts_toward_pomodoro");
    s = serde_json::from_value(json).unwrap();
    assert!(!s.settings.manual_counts_toward_pomodoro);
    assert!(!s.timer.as_ref().unwrap().counts_toward_pomodoro);
    s.settings.manual_counts_toward_pomodoro = true;
    run(&mut s, 120);
    assert!(apply(&mut s, Command::Reset).is_empty());
    assert_eq!(s.shared_progress, 0);
    let command = serde_json::from_str(
        r#"{"type":"save_settings","focus_scope":"shared","tick_sound":false,"tick_volume":100}"#,
    )
    .unwrap();
    apply(&mut s, command);
    assert!(s.settings.manual_counts_toward_pomodoro);
}

#[test]
fn alarm_duration_defaults_validates_and_legacy_commands_preserve_it() {
    let mut s = State::new(false);
    let mut old = serde_json::to_value(&s).unwrap();
    old["settings"]
        .as_object_mut()
        .unwrap()
        .remove("alarm_sound_seconds");
    s = serde_json::from_value(old).unwrap();
    assert_eq!(s.settings.alarm_sound_seconds, 30);
    for seconds in [0, 30, 60] {
        apply(
            &mut s,
            Command::SaveSettings {
                alarm_sound_seconds: Some(seconds),
                manual_counts_toward_pomodoro: None,
                focus_scope: Scope::Shared,
                tick_sound: false,
                tick_volume: 100,
            },
        );
        let command = serde_json::from_str(r#"{"type":"save_settings","focus_scope":"shared","tick_sound":false,"tick_volume":100}"#).unwrap();
        apply(&mut s, command);
        assert_eq!(s.settings.alarm_sound_seconds, seconds);
        s.validate().unwrap();
    }
    assert!(
        s.apply(
            &Command::SaveSettings {
                alarm_sound_seconds: Some(45),
                manual_counts_toward_pomodoro: None,
                focus_scope: Scope::Shared,
                tick_sound: false,
                tick_volume: 100,
            },
            NOW
        )
        .is_err()
    );
    assert_eq!(s.settings.alarm_sound_seconds, 60);
}
