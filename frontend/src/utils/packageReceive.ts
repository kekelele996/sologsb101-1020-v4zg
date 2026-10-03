/**
 * 院外校勘组核验包收包逻辑
 * - 包级结构校验：不合法整包拒收；合法包先在 packages 表留档（校勘组侧留存）
 * - 按碑刻逐个认：每块碑刻独立事务并账，失败只回滚这一块，认好的保留
 * - 编目员登记的拓法/纸墨/尺寸与钤印不被包里的值压掉
 * - 断代结论依据的字位在编目台后来动过（updatedAt 晚于结论日期），结论退回待核
 * - 早期旧包只有行号没有字位，收包时按行号顺序补出坐标
 */
import { createId, db } from './db';
import type { RubbingSnapshot } from './db';
import type { Loss } from '@/types/loss';
import type { Seal } from '@/types/seal';
import type { Rubbing } from '@/types/rubbing';
import type { Compare, CompareReviewState } from '@/types/compare';
import { STELE_FORM_LABEL, type SteleForm } from '@/types/stele';
import { INK_TONE_LABEL, RUBBING_METHOD_LABEL, RUBBING_STATE_LABEL } from '@/types/rubbing';
import { LOSS_SEVERITY_LABEL, LOSS_TYPE_LABEL } from '@/types/loss';
import { SEAL_TYPE_LABEL } from '@/types/seal';
import { COMPARE_CONCLUSION_LABEL } from '@/types/compare';
import { backfillLossCharNo, coordKey, diffLosses, encodeCoord } from './collate';
import {
  CATALOGER_RUBBING_FIELDS,
  type PackageReceiveSummary,
  type PackageSteleResult,
  type PackageStatus,
  type ReceivedPackage,
  type SteleRetrySummary,
} from '@/types/packageReceive';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPositiveInt = (value: unknown): value is number => isNumber(value) && value > 0 && Number.isInteger(value);
const oneOf = <T extends string>(value: unknown, table: Record<T, string>): value is T =>
  isString(value) && Object.prototype.hasOwnProperty.call(table, value);

/* ------------------------------ 包级结构校验 ------------------------------ */

/**
 * 核验包结构校验（与整库备份同构）。
 * 返回错误文案；空串表示通过。结构性问题（缺集合 / 主键重复 / 枚举非法 / 引用悬空）整包拒收。
 */
export function validateVerificationPackage(input: unknown): string {
  if (!isObject(input)) return '文件内容不是合法的 JSON 对象';
  if (input.app !== 'gbrubbing') return `核验包不属于本项目（app=${String(input.app)}）`;
  for (const key of ['steles', 'rubbings', 'losses', 'seals', 'compares'] as const) {
    if (!Array.isArray(input[key])) return `核验包缺少 ${key} 集合`;
  }
  const snapshot = input as unknown as RubbingSnapshot;

  const checkTimestamps = (row: Record<string, unknown>, where: string): string => {
    if (!isNumber(row.createdAt) || !isNumber(row.updatedAt)) return `${where} 缺少合法的 createdAt / updatedAt`;
    return '';
  };

  const steleIds = new Set<string>();
  for (const raw of snapshot.steles) {
    if (!isObject(raw) || !isString(raw.id) || raw.id.length === 0) return '存在缺少主键的碑刻记录';
    if (steleIds.has(raw.id)) return `碑刻主键重复：${raw.id}`;
    const where = `碑刻 ${raw.id}`;
    for (const field of ['title', 'era', 'location', 'sizeCm', 'calligrapher']) {
      if (!isString(raw[field])) return `${where} 的 ${field} 字段不合法`;
    }
    if (!oneOf<SteleForm>(raw.form, STELE_FORM_LABEL)) return `${where} 的形制字段不合法`;
    const tsError = checkTimestamps(raw, where);
    if (tsError) return tsError;
    steleIds.add(raw.id);
  }

  const rubbingIds = new Set<string>();
  for (const raw of snapshot.rubbings) {
    if (!isObject(raw) || !isString(raw.id) || raw.id.length === 0) return '存在缺少主键的拓本记录';
    if (rubbingIds.has(raw.id)) return `拓本主键重复：${raw.id}`;
    const where = `拓本 ${raw.id}`;
    if (!steleIds.has(raw.steleId as string)) return `${where} 引用了包内不存在的碑刻 ${String(raw.steleId)}`;
    if (!isPositiveInt(raw.versionNo)) return `${where} 的版本号不合法`;
    if (!oneOf(raw.method, RUBBING_METHOD_LABEL)) return `${where} 的拓法字段不合法`;
    if (!oneOf(raw.inkTone, INK_TONE_LABEL)) return `${where} 的墨色字段不合法`;
    if (!oneOf(raw.state, RUBBING_STATE_LABEL)) return `${where} 的状态字段不合法`;
    for (const field of ['paperType', 'sizeCm', 'collectionNo', 'dateGuess']) {
      if (!isString(raw[field])) return `${where} 的 ${field} 字段不合法`;
    }
    const tsError = checkTimestamps(raw, where);
    if (tsError) return tsError;
    rubbingIds.add(raw.id);
  }

  for (const raw of snapshot.losses) {
    if (!isObject(raw) || !isString(raw.id) || raw.id.length === 0) return '存在缺少主键的损泐字位记录';
    const where = `字位 ${raw.id}`;
    if (!rubbingIds.has(raw.rubbingId as string)) return `${where} 引用了包内不存在的拓本 ${String(raw.rubbingId)}`;
    if (!isPositiveInt(raw.lineNo)) return `${where} 的行号不合法`;
    // 校勘组早期数据只带行号、没有字位（charNo 缺失 / 为 0 或非正数），收包归一化时按行号顺序补坐标
    if (raw.charNo !== undefined && raw.charNo !== null && typeof raw.charNo !== 'number') {
      return `${where} 的字位不合法`;
    }
    if (!oneOf(raw.type, LOSS_TYPE_LABEL)) return `${where} 的损泐类型不合法`;
    if (!oneOf(raw.severity, LOSS_SEVERITY_LABEL)) return `${where} 的严重程度不合法`;
    if (!isString(raw.note)) return `${where} 的备注字段不合法`;
    const tsError = checkTimestamps(raw, where);
    if (tsError) return tsError;
  }

  for (const raw of snapshot.seals) {
    if (!isObject(raw) || !isString(raw.id) || raw.id.length === 0) return '存在缺少主键的钤印记录';
    const where = `钤印 ${raw.id}`;
    if (!rubbingIds.has(raw.rubbingId as string)) return `${where} 引用了包内不存在的拓本 ${String(raw.rubbingId)}`;
    if (!oneOf(raw.sealType, SEAL_TYPE_LABEL)) return `${where} 的印别不合法`;
    for (const field of ['sealText', 'position', 'transcription']) {
      if (!isString(raw[field])) return `${where} 的 ${field} 字段不合法`;
    }
    const tsError = checkTimestamps(raw, where);
    if (tsError) return tsError;
  }

  for (const raw of snapshot.compares) {
    if (!isObject(raw) || !isString(raw.id) || raw.id.length === 0) return '存在缺少主键的比对记录';
    const where = `比对 ${raw.id}`;
    if (!steleIds.has(raw.steleId as string)) return `${where} 引用了包内不存在的碑刻 ${String(raw.steleId)}`;
    const rubbingOfStele = snapshot.rubbings.some(
      (rubbing) => rubbing.steleId === raw.steleId && rubbing.id === raw.rubbingIdA,
    );
    const rubbingBOfStele = snapshot.rubbings.some(
      (rubbing) => rubbing.steleId === raw.steleId && rubbing.id === raw.rubbingIdB,
    );
    if (!rubbingOfStele || !rubbingBOfStele) return `${where} 引用的拓本不在该碑刻下`;
    if (raw.rubbingIdA === raw.rubbingIdB) return `${where} 的 A/B 拓本不能相同`;
    if (!Number.isInteger(raw.diffCount) || (raw.diffCount as number) < 0) return `${where} 的差异字数不合法`;
    if (!oneOf(raw.conclusion, COMPARE_CONCLUSION_LABEL)) return `${where} 的断代结论不合法`;
    for (const field of ['operator', 'date']) {
      if (!isString(raw[field])) return `${where} 的 ${field} 字段不合法`;
    }
    const tsError = checkTimestamps(raw, where);
    if (tsError) return tsError;
  }

  return '';
}

/* ------------------------------ 归一化（旧包补坐标） ------------------------------ */

/**
 * 收包归一化：校勘组早期数据只带行号没有字位，按行号顺序补出坐标。
 * 返回补齐坐标的快照（不修改入参）与补位条数。
 */
export function normalizeVerificationSnapshot(snapshot: RubbingSnapshot): {
  snapshot: RubbingSnapshot;
  backfilledCount: number;
} {
  const cloned: RubbingSnapshot = structuredClone(snapshot);
  const before = cloned.losses.filter((loss) => typeof loss.charNo !== 'number' || loss.charNo <= 0).length;
  cloned.losses = before > 0 ? backfillLossCharNo(cloned.losses) : cloned.losses;
  return { snapshot: cloned, backfilledCount: before };
}

/* ------------------------------ 按碑刻核验并账 ------------------------------ */

function earliest(a: number, b: number): number {
  return Math.min(a, b);
}
function latest(a: number, b: number): number {
  return Math.max(a, b);
}

/** 结论依据的时间界限：结论日期当天结束；无法解析时退回包导出时间，再退回 0（全部视为后来动过） */
function conclusionCutoff(compare: Compare, exportedAt: string | undefined): number {
  const endOfDay = Date.parse(`${compare.date}T23:59:59`);
  if (Number.isFinite(endOfDay)) return endOfDay;
  const exported = exportedAt ? Date.parse(exportedAt) : NaN;
  if (Number.isFinite(exported)) return exported;
  return 0;
}

/**
 * 核对单块碑刻并写库：成功返回 ok 结果（含退回待核的比对），校验失败只返回 failed 结果且不写任何数据。
 * 整个碑刻在一个 Dexie 事务内完成，写库异常时该事务整体回滚，不影响其他碑刻。
 */
export async function reconcileStele(steleId: string, snapshot: RubbingSnapshot): Promise<PackageSteleResult> {
  const pkgStele = snapshot.steles.find((item) => item.id === steleId);
  const title = pkgStele?.title ?? '未命名碑刻';
  const fail = (error: string): PackageSteleResult => ({
    steleId,
    title,
    status: 'failed',
    error,
    heldCompareIds: [],
    attempts: 1,
    checkedAt: Date.now(),
  });

  if (!pkgStele) return fail('核验包内找不到该碑刻');

  const pkgRubbings = snapshot.rubbings.filter((rubbing) => rubbing.steleId === steleId);
  const pkgRubbingIds = new Set(pkgRubbings.map((rubbing) => rubbing.id));
  const pkgLosses = snapshot.losses.filter((loss) => pkgRubbingIds.has(loss.rubbingId));
  const pkgSeals = snapshot.seals.filter((seal) => pkgRubbingIds.has(seal.rubbingId));
  const pkgCompares = snapshot.compares.filter((compare) => compare.steleId === steleId);

  // 先在事务外读本地现状并核对（认碑）：任何一处对不上就整块不写
  const [localStele, localRubbings, allLocalLosses, allLocalSeals, localCompares] = await Promise.all([
    db.steles.get(steleId),
    db.rubbings.where('steleId').equals(steleId).toArray(),
    db.losses.toArray(),
    db.seals.toArray(),
    db.compares.where('steleId').equals(steleId).toArray(),
  ]);
  const localLosses = allLocalLosses.filter((loss) => pkgRubbingIds.has(loss.rubbingId));
  const localSeals = allLocalSeals.filter((seal) => pkgRubbingIds.has(seal.rubbingId));

  // ① 包内同碑拓本版本序号重复
  const versionSeen = new Map<number, string>();
  for (const rubbing of pkgRubbings) {
    const otherId = versionSeen.get(rubbing.versionNo);
    if (otherId) return fail(`包内第 ${rubbing.versionNo} 版对应两份拓本（${otherId} / ${rubbing.id}），无法认领`);
    versionSeen.set(rubbing.versionNo, rubbing.id);
  }

  // ② 同碑同版本序号但拓本 id 不一致 → 不认，整块失败等人工处理
  for (const rubbing of pkgRubbings) {
    const clash = localRubbings.find((item) => item.versionNo === rubbing.versionNo && item.id !== rubbing.id);
    if (clash) {
      return fail(`第 ${rubbing.versionNo} 版本地是拓本 ${clash.id}，包内是 ${rubbing.id}，编号对不上，已整块退回`);
    }
  }

  // ③ 包内同一拓本字位坐标重复
  const pkgCoordSeen = new Map<string, string>();
  for (const loss of pkgLosses) {
    const key = `${loss.rubbingId}#${coordKey(loss)}`;
    const otherId = pkgCoordSeen.get(key);
    if (otherId) return fail(`包内字位 ${encodeCoord(loss.lineNo, loss.charNo)} 记录重复（${otherId} / ${loss.id}）`);
    pkgCoordSeen.set(key, loss.id);
  }

  // ④ 同拓本同坐标本地已登记了另一条字位 → 编目台后来动过且无法按 id 对上，不能盖
  for (const loss of pkgLosses) {
    const clash = localLosses.find(
      (item) => item.rubbingId === loss.rubbingId && item.lineNo === loss.lineNo && item.charNo === loss.charNo && item.id !== loss.id,
    );
    if (clash) {
      return fail(`字位 ${encodeCoord(loss.lineNo, loss.charNo)} 本地另登记为 ${clash.id}，与包内 ${loss.id} 冲突，已整块退回`);
    }
  }

  // 认碑通过，组装并账数据
  const mergedStele = localStele
    ? {
        ...pkgStele,
        createdAt: earliest(pkgStele.createdAt, localStele.createdAt),
        updatedAt: latest(pkgStele.updatedAt, localStele.updatedAt),
      }
    : pkgStele;

  // 拓本：同 id 已存在时，拓法 / 纸种 / 墨色 / 尺寸保留编目台的值
  const mergedRubbings: Rubbing[] = pkgRubbings.map((pkgRubbing) => {
    const local = localRubbings.find((item) => item.id === pkgRubbing.id);
    if (!local) return pkgRubbing;
    // 拓法 / 纸种 / 墨色 / 尺寸保留编目台的值，不被包压
    const protectedPatch: Pick<Rubbing, (typeof CATALOGER_RUBBING_FIELDS)[number]> = {
      method: local.method,
      paperType: local.paperType,
      inkTone: local.inkTone,
      sizeCm: local.sizeCm,
    };
    return {
      ...pkgRubbing,
      ...protectedPatch,
      createdAt: earliest(pkgRubbing.createdAt, local.createdAt),
      updatedAt: latest(pkgRubbing.updatedAt, local.updatedAt),
    };
  });

  // 钤印：包里没有的本地钤印保留；同 id 的钤印不被包压（编目员登记为准）；包内新钤印补入
  const mergedSeals: Seal[] = (() => {
    const byId = new Map<string, Seal>();
    pkgSeals.forEach((seal) => byId.set(seal.id, seal));
    localSeals.forEach((local) => {
      const pkg = byId.get(local.id);
      if (!pkg) {
        byId.set(local.id, local);
      } else {
        byId.set(local.id, {
          ...pkg,
          // 钤印内容全部保留编目台登记值
          sealText: local.sealText,
          position: local.position,
          transcription: local.transcription,
          sealType: local.sealType,
          createdAt: earliest(pkg.createdAt, local.createdAt),
          updatedAt: latest(pkg.updatedAt, local.updatedAt),
        });
      }
    });
    return [...byId.values()];
  })();

  // 字位：按 id 并账，本地字位（含编目员新登）保留，时间戳取并集以便识别「后来动过」
  const mergedLosses: Loss[] = (() => {
    const byId = new Map<string, Loss>();
    pkgLosses.forEach((loss) => byId.set(loss.id, loss));
    localLosses.forEach((local) => {
      const pkg = byId.get(local.id);
      if (!pkg) {
        byId.set(local.id, local);
      } else {
        byId.set(local.id, {
          ...pkg,
          createdAt: earliest(pkg.createdAt, local.createdAt),
          updatedAt: latest(pkg.updatedAt, local.updatedAt),
        });
      }
    });
    return [...byId.values()];
  })();

  // 比对结论：依据字位若在编目台后来动过，退回待核
  const lossByRubbingAndCoord = new Map<string, Loss>();
  mergedLosses.forEach((loss) => {
    lossByRubbingAndCoord.set(`${loss.rubbingId}#${coordKey(loss)}`, loss);
  });

  const mergedCompares: Compare[] = pkgCompares.map((pkgCompare) => {
    const local = localCompares.find((item) => item.id === pkgCompare.id);
    const basis = diffLosses(
      pkgLosses.filter((loss) => loss.rubbingId === pkgCompare.rubbingIdA),
      pkgLosses.filter((loss) => loss.rubbingId === pkgCompare.rubbingIdB),
    );
    const evidence = basis.rows.filter((row) => row.diffKind !== 'same');
    const cutoff = conclusionCutoff(pkgCompare, snapshot.exportedAt);
    const movedCoords: string[] = [];
    evidence.forEach((row) => {
      const localA = lossByRubbingAndCoord.get(`${pkgCompare.rubbingIdA}#${row.lineNo}:${row.charNo}`);
      const localB = lossByRubbingAndCoord.get(`${pkgCompare.rubbingIdB}#${row.lineNo}:${row.charNo}`);
      if ((localA && localA.updatedAt > cutoff) || (localB && localB.updatedAt > cutoff)) {
        movedCoords.push(encodeCoord(row.lineNo, row.charNo));
      }
    });
    const held = movedCoords.length > 0;
    const reviewState: CompareReviewState = held ? 'held' : 'verified';
    return {
      ...pkgCompare,
      conclusion: held ? 'pending' : pkgCompare.conclusion,
      reviewState,
      holdReason: held ? `依据字位 ${movedCoords.slice(0, 3).join('、')} 收包前已在编目台改动，结论退回待核` : '',
      createdAt: earliest(pkgCompare.createdAt, local?.createdAt ?? pkgCompare.createdAt),
      updatedAt: latest(pkgCompare.updatedAt, local?.updatedAt ?? 0),
    };
  });
  const heldCompareIds = mergedCompares.filter((compare) => compare.reviewState === 'held').map((compare) => compare.id);

  try {
    await db.transaction(
      'rw',
      [db.steles, db.rubbings, db.losses, db.seals, db.compares],
      async () => {
        await db.steles.put(mergedStele);
        if (mergedRubbings.length > 0) await db.rubbings.bulkPut(mergedRubbings);
        if (mergedLosses.length > 0) await db.losses.bulkPut(mergedLosses);
        if (mergedSeals.length > 0) await db.seals.bulkPut(mergedSeals);
        if (mergedCompares.length > 0) await db.compares.bulkPut(mergedCompares);
      },
    );
  } catch (error) {
    // 事务已整体回滚：这一块没认成，其他碑刻不受影响
    return fail(`写库失败，本块已回滚：${error instanceof Error ? error.message : '未知错误'}`);
  }

  return {
    steleId,
    title,
    status: 'ok',
    heldCompareIds,
    attempts: 1,
    checkedAt: Date.now(),
  };
}

function packageStatus(results: PackageSteleResult[]): PackageStatus {
  return results.some((result) => result.status === 'failed') ? 'partial' : 'ok';
}

/* ------------------------------ 收包 / 重试 ------------------------------ */

/**
 * 收取核验包：归一化补坐标后按碑刻逐个核验，原包在 packages 表留档。
 * 调方应先通过 validateVerificationPackage 校验。
 */
export async function receiveVerificationPackage(rawSnapshot: RubbingSnapshot): Promise<PackageReceiveSummary> {
  const { snapshot, backfilledCount } = normalizeVerificationSnapshot(rawSnapshot);
  const results: PackageSteleResult[] = [];
  for (const stele of snapshot.steles) {
    // 每块碑刻独立事务：失败只回滚这一块，认好的留下
    // eslint-disable-next-line no-await-in-loop
    results.push(await reconcileStele(stele.id, snapshot));
  }

  const now = Date.now();
  const record: ReceivedPackage = {
    id: createId('pkg'),
    exportedAt: snapshot.exportedAt,
    schemaVersion: snapshot.schemaVersion,
    status: packageStatus(results),
    receivedAt: now,
    backfilledCoordCount: backfilledCount,
    steleCount: snapshot.steles.length,
    results,
    snapshot,
  };
  await db.packages.put(record);

  return {
    packageId: record.id,
    steleCount: results.length,
    okCount: results.filter((result) => result.status === 'ok').length,
    failedCount: results.filter((result) => result.status === 'failed').length,
    heldCount: results.reduce((sum, result) => sum + (result.heldCompareIds?.length ?? 0), 0),
    backfilledCoordCount: backfilledCount,
    results,
  };
}

/** 重算单个核验包里某一块失败的碑刻；认好后更新留档状态 */
export async function retryPackageStele(packageId: string, steleId: string): Promise<SteleRetrySummary> {
  const record = await db.packages.get(packageId);
  if (!record) throw new Error('核验包留档不存在');
  const index = record.results.findIndex((result) => result.steleId === steleId);
  if (index < 0) throw new Error('该碑刻不在核验包内');

  const previous = record.results[index] as PackageSteleResult;
  const result = await reconcileStele(steleId, record.snapshot);
  result.attempts = previous.attempts + 1;
  record.results[index] = result;
  record.status = packageStatus(record.results);
  await db.packages.put(record);
  return { packageId, result, status: record.status };
}

export interface FailedRetryOutcome {
  retriedPackages: number;
  retriedSteles: number;
  recovered: number;
  stillFailed: number;
}

/** 启动时调用：只重算所有留档核验包里仍失败的碑刻，认好的块不重复处理 */
export async function retryFailedPackages(): Promise<FailedRetryOutcome> {
  const packages = await db.packages.where('status').equals('partial').toArray();
  let retriedSteles = 0;
  let recovered = 0;
  for (const record of packages) {
    let changed = false;
    record.results.forEach((result) => {
      if (result.status !== 'failed') return;
      changed = true;
      retriedSteles += 1;
    });
    if (!changed) continue;
    // 逐块重算（事务互相独立）
    for (let i = 0; i < record.results.length; i += 1) {
      const previous = record.results[i] as PackageSteleResult;
      if (previous.status !== 'failed') continue;
      // eslint-disable-next-line no-await-in-loop
      const result = await reconcileStele(previous.steleId, record.snapshot);
      result.attempts = previous.attempts + 1;
      record.results[i] = result;
      if (result.status === 'ok') recovered += 1;
    }
    record.status = packageStatus(record.results);
    // eslint-disable-next-line no-await-in-loop
    await db.packages.put(record);
  }
  return {
    retriedPackages: packages.length,
    retriedSteles,
    recovered,
    stillFailed: retriedSteles - recovered,
  };
}

/** 删除核验包留档（只删校勘组侧的包，不影响已并账的业务数据） */
export async function removeReceivedPackage(packageId: string): Promise<void> {
  await db.packages.delete(packageId);
}
