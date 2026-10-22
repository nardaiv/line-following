export type ControlMode = 'track' | 'pivot' | 'lost';
export type AckStatus = 'applied' | 'persisted' | 'rejected' | 'failed';

export interface Telemetry {
  robotId: string;
  bootId: string;
  sequence: number;
  receivedAt: string;
  uptimeMs: number;
  mask: number;
  position: number | null;
  error: number | null;
  correction: number;
  leftPwm: number;
  rightPwm: number;
  mode: ControlMode;
  dtMs: number;
  pidRevision: number;
  droppedFrames: number;
  droppedAcks: number;
  droppedEvents: number;
}

export interface PidGains {
  kp: number;
  ki: number;
  kd: number;
}

export interface PidState extends PidGains {
  revision: number;
  persisted: boolean;
  requestId: string | null;
  receivedAt: string | null;
}

export interface RobotStatus {
  state: 'online' | 'offline';
  wifi: string | null;
  rssi: number | null;
  receivedAt: string | null;
}

export interface PidAck {
  requestId: string;
  status: AckStatus;
  revision: number;
  reason: string | null;
}

export interface GainDraft {
  kp: string;
  ki: string;
  kd: string;
}

export const GAIN_LIMITS: Readonly<PidGains>;
export function chooseRobotId(available: string[], current: string): string;
export function normalizeTelemetry(value: unknown): Telemetry | null;
export function getSensorStates(mask: number): boolean[];
export function getSensorState(mask: number, index: number, hasSample: boolean): 'line' | 'clear' | 'unknown';
export function parseGainDraft(draft: GainDraft): PidGains | null;
export function normalizePidState(value: unknown): PidState | null;
export function normalizeStatus(value: unknown): RobotStatus | null;
export function normalizePidAck(value: unknown): PidAck | null;
