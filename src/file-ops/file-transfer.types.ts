export type FileTransferState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export type FileTransferDirection = 'upload' | 'download';

export interface FileTransferRecord {
  id: string;
  transferId: string;
  deviceId: string;
  serverId: string;
  browserSessionId: string | null;
  sessionId: string | null;
  actorType: string | null;
  actorId: string | null;
  state: FileTransferState;
  direction: FileTransferDirection;
  localPath: string | null;
  remotePath: string | null;
  recursive: boolean;
  overwritePolicy: string | null;
  followSymlinks: boolean;
  rateLimitKbps: number | null;
  verifyChecksum: boolean;
  preserveMtime: boolean;
  preserveMode: boolean;
  attempt: number;
  maxAttempts: number;
  resumeSupported: boolean;
  retryScheduled: boolean;
  resumeToken: string | null;
  resumeOffsetBytes: number | null;
  tempPathHint: string | null;
  progressEventCount: number;
  firstProgressAt: string | null;
  lastProgressAt: string | null;
  finalizeSeen: boolean;
  bytesTransferred: number;
  bytesTotal: number | null;
  percent: number | null;
  throughputBps: number | null;
  etaSec: number | null;
  phase: string | null;
  reasonCode: string | null;
  reasonDetail: string | null;
  message: string | null;
  commandId: string | null;
  reqSeq: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
