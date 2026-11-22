type Mode = "manual" | "pomodoro";
export type Status = "idle" | "running" | "paused" | "choice" | "alarm";
type Scope = "shared" | "per_subject";
type Timer = {
  counts_toward_pomodoro?: boolean;
  phase: "manual" | "focus" | "break";
  total_seconds: number;
  remaining_seconds: number;
  subject: string;
  suspended_focus: Timer | null;
  return_to_choice: boolean;
};
export type State = {
  revision: number;
  tick_sequence: number;
  mode: Mode;
  subject: string;
  status: Status;
  timer: Timer | null;
  balance_seconds: number;
  cycle_position: number;
  shared_progress: number;
  per_subject_progress: Record<string, number>;
  settings: {
    alarm_sound_seconds?: number;
    manual_counts_toward_pomodoro?: boolean;
    focus_scope: Scope;
    tick_sound: boolean;
    tick_volume: number;
  };
  subjects: string[];
  focus_seconds: number;
  alarm_id: string | null;
};
type Snapshot = {
  state: State;
  server_time_ms: number;
  storage_error: string | null;
  preview: boolean;
};
type Backend = "local" | "server";
type CloseBehavior = "tray" | "quit";
export type View = {
  snapshot: Snapshot | null;
  connection: string;
  endpoint: string;
  has_token: boolean;
  pending: string | null;
  error: string | null;
  profile: string;
  preview: boolean;
  backend?: Backend;
  next_backend?: Backend;
  close_behavior?: CloseBehavior;
  initializing?: boolean;
  import_available?: boolean;
  tray_available?: boolean;
  backup_path?: string | null;
};
type Session = {
  session_id: string;
  subject: string;
  duration_seconds: number;
  recorded_at: string;
  mode: Mode;
};
type Summary = { subject: string; duration_seconds: number; count: number };
export type History = { type: "history"; sessions: Session[]; summary: Summary[] };
export type Command = { type: string; [key: string]: string | number | boolean };
