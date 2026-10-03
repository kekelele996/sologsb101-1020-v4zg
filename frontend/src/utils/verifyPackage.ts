/**
 * 核验包接收逻辑（校勘组回传结果）
 * - 旧包升级：为缺失 charNo 的字位按行号顺序补出坐标
 * - 按碑刻逐个核验：编目员填的拓法 / 纸墨 / 尺寸与钤印本地优先，不被包里的值压掉
 * - 包里断代结论依据的字位若在本地被动过，结论先退回待核
 * - 单碑事务：核对失败只回滚这一块，认好的留着
 * 纯本地逻辑，不经过任何服务端。
 */
import type { Compare, CompareConclusion } from '@/types/compare';
import type { Loss } from '@/types/loss';
import type { Rubbing } from '@/types/rubbing';
import type { Seal } from '@/types/seal';
import type { Stele } from '@/types/stele';
import type { SteleVerifyState } from '@/types/package';
import { coordKey, sortLosses } from './collate';
import { DB_NAME, DB_SCHEMA_VERSION, db, type RubbingSnapshot } from './db';

export interface LocalData {
  steles: Stele[];
  rubbings: Rubbing[];
  losses: Loss[];
  seals: Seal[];
  compares: Compare[];
}

export interface PackageUpgradeResult {
  snapshot: RubbingSnapshot;
  upgradedLossCount: number;
}

/** 旧包升级：为缺失 charNo 的字位按行号顺序补出坐标（与 v1→v2 迁移一致） */
export function upgradePackage(input: RubbingSnapshot): PackageUpgradeResult {
  let upgradedLossCount = 0;
  const byRubbing = new Map<string, Loss[]>();
  input.losses.forEach((loss) => {
    byRubbing.set(loss.rubbingId, [...(byRubbing.get(loss.rubbingId) ?? []), loss]);
  });
  const rebuilt: Loss[] = [];
  byRubbing.forEach((list) => {
    // 按行号排序后，为缺失 charNo 的旧记录在行内顺序补位
    const sorted = [...list].sort((a, b) => a.lineNo - b.lineNo);
    const counter = new Map<number, number>();
    sorted.forEach((loss) => {
      const used = counter.get(loss.lineNo) ?? 0;
      const hasCoord = typeof loss.charNo === 'number' && loss.charNo > 0;
      const charNo = hasCoord ? (loss.charNo as number) : used + 1;
      if (!hasCoord) upgradedLossCount += 1;
      counter.set(loss.lineNo, Math.max(used, charNo));
      rebuilt.push({ ...loss, charNo });
    });
  });
  return { snapshot: { ...input, losses: sortLosses(rebuilt) }, upgradedLossCount };
}

interface SteleOps {
  steles: Stele[];
  rubbings: Rubbing[];
  losses: Loss[];
  seals: Seal[];
  compares: Compare[];
}

const emptyOps = (): SteleOps => ({ steles: [], rubbings: [], losses: [], seals: [], compares: [] });

function sameCoordSet(a: Loss[], b: Loss[]): boolean {
  const sa = new Set(a.map(coordKey));
  const sb = new Set(b.map(coordKey));
  if (sa.size !== sb.size) return false;
  for (const key of sa) {
    if (!sb.has(key)) return false;
  }
  return true;
}

/** 核验单块碑刻：返回核验状态与待写入操作（纯函数，不触库） */
export function verifySteleCompute(
  steleId: string,
  snapshot: RubbingSnapshot,
  local: LocalData,
): { state: SteleVerifyState; ops: SteleOps } {
  const base: SteleVerifyState = {
    steleId,
    title: snapshot.steles.find((s) => s.id === steleId)?.title ?? steleId,
    status: 'pending',
    reason: '',
    pendingCompareIds: [],
  };
  const fail = (reason: string): { state: SteleVerifyState; ops: SteleOps } => ({
    state: { ...base, status: 'failed', reason },
    ops: emptyOps(),
  });

  const stele = snapshot.steles.find((s) => s.id === steleId);
  if (!stele) return fail('包内缺少该碑刻档案');

  const pkgRubbings = snapshot.rubbings.filter((r) => r.steleId === steleId);
  const pkgRubbingIds = new Set(pkgRubbings.map((r) => r.id));
  // 引用的拓本必须在包内或本地存在，否则成了无主记录
  const allRubbingIds = new Set([...snapshot.rubbings.map((r) => r.id), ...local.rubbings.map((r) => r.id)]);
  const pkgLosses = snapshot.losses.filter((l) => pkgRubbingIds.has(l.rubbingId));
  const pkgSeals = snapshot.seals.filter((s) => pkgRubbingIds.has(s.rubbingId));
  const pkgCompares = snapshot.compares.filter((c) => c.steleId === steleId);

  for (const loss of pkgLosses) {
    if (!allRubbingIds.has(loss.rubbingId)) return fail(`损泐字位 ${loss.id} 引用了不存在的拓本 ${loss.rubbingId}`);
  }
  for (const seal of pkgSeals) {
    if (!allRubbingIds.has(seal.rubbingId)) return fail(`钤印 ${seal.id} 引用了不存在的拓本 ${seal.rubbingId}`);
  }
  for (const cmp of pkgCompares) {
    if (cmp.rubbingIdA && !allRubbingIds.has(cmp.rubbingIdA))
      return fail(`比对记录 ${cmp.id} 的 A 拓本 ${cmp.rubbingIdA} 不存在`);
    if (cmp.rubbingIdB && !allRubbingIds.has(cmp.rubbingIdB))
      return fail(`比对记录 ${cmp.id} 的 B 拓本 ${cmp.rubbingIdB} 不存在`);
  }

  const ops = emptyOps();
  const localRubbingIds = new Set(local.rubbings.map((r) => r.id));

  // 碑刻：本地已存在则保留编目台档案，缺失则补入
  if (!local.steles.some((s) => s.id === steleId)) ops.steles.push(stele);

  // 拓本：编目员填的拓法 / 纸墨 / 尺寸本地优先，不被包里的值压掉；缺失则补入并置待编目
  const maxVersionByStele = new Map<string, number>();
  local.rubbings.forEach((r) => {
    maxVersionByStele.set(r.steleId, Math.max(maxVersionByStele.get(r.steleId) ?? 0, r.versionNo));
  });
  pkgRubbings.forEach((r) => {
    if (localRubbingIds.has(r.id)) return;
    const nextVersion = (maxVersionByStele.get(r.steleId) ?? 0) + 1;
    maxVersionByStele.set(r.steleId, nextVersion);
    ops.rubbings.push({ ...r, versionNo: nextVersion, state: 'toCatalog' });
  });

  // 钤印：本地优先，缺失补入
  const localSealIds = new Set(local.seals.map((s) => s.id));
  pkgSeals.forEach((s) => {
    if (!localSealIds.has(s.id)) ops.seals.push(s);
  });

  // 损泐字位：本地优先（行号字位不被包回退），缺失补入
  const localLossIds = new Set(local.losses.map((l) => l.id));
  pkgLosses.forEach((l) => {
    if (!localLossIds.has(l.id)) ops.losses.push(l);
  });

  // 比对结论：包内结论为依据；若依据字位在本地被动过，结论先退回待核
  const localCompareIds = new Set(local.compares.map((c) => c.id));
  pkgCompares.forEach((cmp) => {
    if (localCompareIds.has(cmp.id)) return;
    let drifted = false;
    for (const rubbingId of [cmp.rubbingIdA, cmp.rubbingIdB]) {
      if (!rubbingId || !localRubbingIds.has(rubbingId)) continue; // 新拓本无本地漂移
      const pkgCoords = pkgLosses.filter((l) => l.rubbingId === rubbingId);
      const locCoords = local.losses.filter((l) => l.rubbingId === rubbingId);
      if (!sameCoordSet(pkgCoords, locCoords)) drifted = true;
    }
    const conclusion: CompareConclusion = drifted ? 'pending' : cmp.conclusion;
    if (drifted) base.pendingCompareIds.push(cmp.id);
    ops.compares.push({ ...cmp, conclusion });
  });

  return { state: { ...base, status: 'recognized', recognizedAt: Date.now() }, ops };
}

/** 接收单块碑刻：在事务内写入，失败只回滚这一块，认好的留着 */
export async function processStele(steleId: string, snapshot: RubbingSnapshot): Promise<SteleVerifyState> {
  const local: LocalData = {
    steles: await db.steles.toArray(),
    rubbings: await db.rubbings.toArray(),
    losses: await db.losses.toArray(),
    seals: await db.seals.toArray(),
    compares: await db.compares.toArray(),
  };
  const { state, ops } = verifySteleCompute(steleId, snapshot, local);
  if (state.status === 'failed') return state;
  try {
    await db.transaction('rw', [db.steles, db.rubbings, db.losses, db.seals, db.compares], async () => {
      if (ops.steles.length > 0) await db.steles.bulkPut(ops.steles);
      if (ops.rubbings.length > 0) await db.rubbings.bulkPut(ops.rubbings);
      if (ops.losses.length > 0) await db.losses.bulkPut(ops.losses);
      if (ops.seals.length > 0) await db.seals.bulkPut(ops.seals);
      if (ops.compares.length > 0) await db.compares.bulkPut(ops.compares);
    });
  } catch (err) {
    return { ...state, status: 'failed', reason: `写入失败：${err instanceof Error ? err.message : String(err)}` };
  }
  return state;
}

/* ------------------------------ 示例核验包（演示收包流程） ------------------------------ */

/** 从当前库构造示例核验包：演示字段保护、补坐标、结论退回待核与单碑失败 */
export function buildSamplePackage(local: LocalData): RubbingSnapshot {
  const now = Date.now();

  const steles = ['stele_01', 'stele_02', 'stele_03']
    .map((id) => local.steles.find((s) => s.id === id))
    .filter((s): s is Stele => Boolean(s));

  const rub = (id: string): Rubbing | undefined => local.rubbings.find((r) => r.id === id);
  const rub_0101 = rub('rub_0101');
  const rub_0102 = rub('rub_0102');
  const rub_0201 = rub('rub_0201');
  const rub_0202 = rub('rub_0202');
  const rub_0301 = rub('rub_0301');

  // 拓本：拓法 / 纸墨 / 尺寸与本地不同，用于验证「编目员字段不被压掉」
  const rubbings: Rubbing[] = [];
  if (rub_0101) rubbings.push({ ...rub_0101, method: 'pat', paperType: '皮纸', inkTone: 'thick', sizeCm: '999×999', updatedAt: now });
  if (rub_0102) rubbings.push({ ...rub_0102, method: 'rub', paperType: '宣纸', sizeCm: '888×888', updatedAt: now });
  if (rub_0201) rubbings.push({ ...rub_0201, updatedAt: now });
  if (rub_0202) rubbings.push({ ...rub_0202, updatedAt: now });
  if (rub_0301) rubbings.push({ ...rub_0301, updatedAt: now });

  // 钤印：seal_0101 同 id 但值不同（验证本地优先），另加一方新印（验证补入）
  const seals: Seal[] = [];
  const seal_0101 = local.seals.find((s) => s.id === 'seal_0101');
  if (seal_0101) seals.push({ ...seal_0101, sealText: '端方藏碑（校勘本）', position: '卷首', updatedAt: now });
  if (rub_0101) {
    seals.push({
      id: 'seal_pkg_01',
      rubbingId: rub_0101.id,
      sealText: '匋斋校勘',
      position: '卷尾',
      transcription: '校勘组钤',
      sealType: 'appraisal',
      createdAt: now,
      updatedAt: now,
    });
  }

  const losses: Loss[] = [];
  // rub_0101 一条旧数据只带行号不带坐标（验证按行号补坐标）
  if (rub_0101) {
    const oldStyle = {
      id: 'loss_pkg_0101',
      rubbingId: rub_0101.id,
      lineNo: 3,
      type: 'blur' as const,
      severity: 'heavy' as const,
      note: '校勘所见漫漶',
      createdAt: now,
      updatedAt: now,
    };
    losses.push(oldStyle as unknown as Loss);
  }
  // stele_02：比对依据字位与本地完全一致 → 结论保留
  if (rub_0201) {
    local.losses
      .filter((l) => l.rubbingId === rub_0201.id)
      .forEach((l, index) => losses.push({ ...l, id: `loss_pkg_0201_${index}`, updatedAt: now }));
  }
  if (rub_0202) {
    local.losses
      .filter((l) => l.rubbingId === rub_0202.id)
      .forEach((l, index) => losses.push({ ...l, id: `loss_pkg_0202_${index}`, updatedAt: now }));
  }

  const today = new Date().toISOString().slice(0, 10);
  const compares: Compare[] = [];
  if (rub_0101 && rub_0102) {
    compares.push({
      id: 'cmp_pkg_01',
      steleId: 'stele_01',
      rubbingIdA: rub_0101.id,
      rubbingIdB: rub_0102.id,
      diffCount: 99,
      conclusion: 'early',
      operator: '校勘组',
      date: today,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (rub_0201 && rub_0202) {
    compares.push({
      id: 'cmp_pkg_02',
      steleId: 'stele_02',
      rubbingIdA: rub_0201.id,
      rubbingIdB: rub_0202.id,
      diffCount: 1,
      conclusion: 'late',
      operator: '校勘组',
      date: today,
      createdAt: now,
      updatedAt: now,
    });
  }
  // stele_03 引用不存在的拓本 → 核对失败
  compares.push({
    id: 'cmp_pkg_03',
    steleId: 'stele_03',
    rubbingIdA: 'rub_9999',
    rubbingIdB: rub_0301?.id ?? 'rub_0301',
    diffCount: 0,
    conclusion: 'pending',
    operator: '校勘组',
    date: today,
    createdAt: now,
    updatedAt: now,
  });

  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    steles,
    rubbings,
    losses,
    seals,
    compares,
  };
}
