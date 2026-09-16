export type MotorTask = "rest" | "posture" | "pronation-supination" | "walk";
export type WristSide = "left" | "right";

export interface ProtocolVersion {
  protocolId: string;
  version: number;
  tasks: Array<{ kind: MotorTask; durationSeconds: number; cueVersion: string }>;
  publishedAt: string;
}

export interface MotorTrial {
  trialId: string;
  visitId: string;
  task: MotorTask;
  side: WristSide;
  medicationTakenAt: string;
  deviceClockStart: number;
  syncPulseAt: number;
  deviations: string[];
}

export interface MetricRun {
  runId: string;
  algorithmVersion: string;
  parameterVersion: string;
  inputTrialIds: string[];
  createdAt: string;
}
