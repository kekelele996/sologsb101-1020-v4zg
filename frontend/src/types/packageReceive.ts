/**
 * 院外校勘组「核验包」收包模型
 * - 校勘组把校完的结果打成核验包（与整库备份同构：五张表全量 + 结构版本号）发回
 * - 编目台收包不整库覆盖，按碑刻逐个核验并账；原包在 packages 表留档，业务五表是编目台侧台账
 */
import type { Stele } from '@/types/stele';
import type { Rubbing } from '@/types/rubbing';
import type { Loss } from '@/types/loss';
import type { Seal } from '@/types/seal';
import type { Compare } from '@/types/compare';
import type { RubbingSnapshot } from '@/utils/db';

/** 核验包整体状态：全部碑刻认好为 ok，含失败块为 partial */
export type PackageStatus = 'ok' | 'partial';

/** 单块碑刻的核验结果 */
export type SteleReceiveStatus = 'ok' | 'failed';

export interface PackageSteleResult {
  steleId: string;
  /** 认碑时取碑名便于回显（包内缺失时为「未命名碑刻」） */
  title: string;
  status: SteleReceiveStatus;
  /** 失败原因（仅 failed） */
  error?: string;
  /** 退回待核的比对记录 id（字位后来动过） */
  heldCompareIds?: string[];
  /** 重试次数 */
  attempts: number;
  /** 最近一次核验时间戳 */
  checkedAt: number;
}

/** packages 表记录：校勘组侧留存的核验包 + 每块碑刻的核验进度 */
export interface ReceivedPackage {
  /** 主键 */
  id: string;
  /** 包内来源（备份文件的 exportedAt，便于区分同批回包） */
  exportedAt: string;
  /** 包内结构版本号 */
  schemaVersion: number;
  /** 整体状态 */
  status: PackageStatus;
  /** 收包时间戳 */
  receivedAt: number;
  /** 收包时按行号顺序补出坐标的旧字位记录条数 */
  backfilledCoordCount: number;
  /** 包内碑刻总数 */
  steleCount: number;
  /** 逐碑刻核验结果 */
  results: PackageSteleResult[];
  /** 核验包全量数据（与整库备份同构，原包留档） */
  snapshot: RubbingSnapshot;
}

export interface PackageReceiveSummary {
  /** 包记录 id */
  packageId: string;
  steleCount: number;
  okCount: number;
  failedCount: number;
  heldCount: number;
  backfilledCoordCount: number;
  results: PackageSteleResult[];
}

/** 重算某块碑刻的返回结果 */
export interface SteleRetrySummary {
  packageId: string;
  result: PackageSteleResult;
  status: PackageStatus;
}

/** 编目员登记的拓本字段：收包时保留编目台的值，校勘组包里的值不覆盖 */
export const CATALOGER_RUBBING_FIELDS = ['method', 'paperType', 'inkTone', 'sizeCm'] as const;

/** 收包导出文件校验：核验包与整库备份同构，app 字段一致 */
export type VerificationSnapshot = {
  app: string;
  schemaVersion?: number;
  exportedAt?: string;
  steles: Stele[];
  rubbings: Rubbing[];
  losses: Loss[];
  seals: Seal[];
  compares: Compare[];
};
