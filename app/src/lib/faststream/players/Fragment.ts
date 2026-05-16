import { DownloadStatus, DownloadStatusType } from '../enums/DownloadStatus';

export const ReferenceTypes = {
  ANALYZER: 1,
  SAVER: 2,
  MP4PLAYER: 3,
} as const;

export type ReferenceType = (typeof ReferenceTypes)[keyof typeof ReferenceTypes];

export class Fragment {
  identifier: string;
  status: DownloadStatusType;
  references: ReferenceType[];
  data: ArrayBuffer | null | (() => ArrayBuffer | null);
  storeRaw: boolean;

  constructor(identifier: string) {
    this.identifier = identifier;
    this.status = DownloadStatus.WAITING;
    this.references = [];
    this.data = null;
    this.storeRaw = false;
  }

  canFree(): boolean {
    return this.references.length <= 0;
  }

  addReference(type: ReferenceType): void {
    if (!this.references.includes(type)) {
      this.references.push(type);
    }
  }

  removeReference(type: ReferenceType): void {
    const idx = this.references.indexOf(type);
    if (idx >= 0) {
      this.references.splice(idx, 1);
    }
  }

  getData(): ArrayBuffer | null {
    if (typeof this.data === 'function') {
      return this.data();
    }
    return this.data;
  }

  setData(data: ArrayBuffer | null | (() => ArrayBuffer | null)): void {
    this.data = data;
  }
}
