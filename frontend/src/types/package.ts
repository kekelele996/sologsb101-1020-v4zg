/**
 * 核验包接收状态模型
 * 校勘组回传的核验包按碑刻逐个核验，每块碑刻有独立的核验状态，
 * 核对失败只回滚这一块，认好的留着，下次打开只重试失败的那几块。
 */
import type { RubbingSnapshot } from '@/utils/db';

/** 单块碑刻的核验状态：待核 / 已认 / 核对失败 */
export type SteleVerifyStatus = 'pending' | 'recognized' | 'failed';

/** 单块碑刻的核验结果 */
export interface SteleVerifyState {
  steleId: string;
  title: string;
  status: SteleVerifyStatus;
  /** 核对失败原因（status=failed 时填写） */
  reason: string;
  /** 依据字位漂移被退回待核的比对记录 id */
  pendingCompareIds: string[];
  recognizedAt?: number;
}

/** 一次核验包接收会话（持久化，便于下次只重试失败项） */
export interface VerifyPackageRecord {
  id: string;
  /** 来源文件名 */
  fileName: string;
  receivedAt: number;
  /** 旧包升级时按行号顺序补出坐标的字位数 */
  upgradedLossCount: number;
  /** 会话状态：进行中 / 全部认好 / 有失败项 */
  status: 'inProgress' | 'completed' | 'partial';
  /** 每块碑刻的核验结果 */
  steles: SteleVerifyState[];
  /** 升级后的原始包快照 */
  snapshot: RubbingSnapshot;
}

export const STELE_VERIFY_STATUS_LABEL: Record<SteleVerifyStatus, string> = {
  pending: '待核',
  recognized: '已认',
  failed: '核对失败',
};

export const STELE_VERIFY_STATUS_COLOR: Record<SteleVerifyStatus, string> = {
  pending: '#8c8c8c',
  recognized: '#2f6f4f',
  failed: '#b03a2e',
};
