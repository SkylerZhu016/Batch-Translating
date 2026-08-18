export type BgeModelSetupStatus =
  | 'detected'
  | 'missing'
  | 'downloading'
  | 'verifying'
  | 'available'
  | 'failed';

export type BgeModelDownloadSource = 'mirror' | 'official';

export type BgeModelSetupErrorCode =
  | 'network'
  | 'disk_space'
  | 'permission'
  | 'checksum'
  | 'invalid_model'
  | 'service_unavailable'
  | 'cancelled'
  | 'unknown';

export interface BgeModelSetupState {
  status: BgeModelSetupStatus;
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  diskAvailableBytes?: number;
  diskRequiredBytes?: number;
  fingerprint?: string;
  modelPath?: string;
  error?: string;
  errorCode?: BgeModelSetupErrorCode;
  disabled?: boolean;
  canRebuild?: boolean;
}
