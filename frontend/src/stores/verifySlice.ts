/**
 * 核验包 slice（Redux Toolkit）
 * 维护校勘组回传核验包的接收会话：收包升级、按碑核验、失败重试与清空。
 * 跨页状态不留在组件内 useState；收包后 dispatch(loadAll()) 刷新业务数据。
 */
import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { createId, db, type RubbingSnapshot } from '@/utils/db';
import { processStele, upgradePackage } from '@/utils/verifyPackage';
import type { SteleVerifyState, VerifyPackageRecord } from '@/types/package';
import type { RootState } from './store';

export interface VerifyState {
  current: VerifyPackageRecord | null;
  loading: boolean;
  error: string;
}

const initialState: VerifyState = { current: null, loading: false, error: '' };

function deriveStatus(steles: SteleVerifyState[]): VerifyPackageRecord['status'] {
  if (steles.length === 0) return 'completed';
  if (steles.every((s) => s.status === 'recognized')) return 'completed';
  if (steles.some((s) => s.status === 'failed')) return 'partial';
  return 'inProgress';
}

/** 载入最近一次核验包接收会话 */
export const loadCurrentPackage = createAsyncThunk('verify/loadCurrent', async () => {
  return (await db.packages.orderBy('receivedAt').reverse().first()) ?? null;
});

/** 接收核验包：升级旧包 → 按碑逐个核验，进度逐条落库（失败只回滚当前碑） */
export const receivePackage = createAsyncThunk(
  'verify/receive',
  async (payload: { fileName: string; snapshot: RubbingSnapshot }, { dispatch }) => {
    const { snapshot, upgradedLossCount } = upgradePackage(payload.snapshot);
    const record: VerifyPackageRecord = {
      id: createId('pkg'),
      fileName: payload.fileName,
      receivedAt: Date.now(),
      upgradedLossCount,
      status: 'inProgress',
      steles: snapshot.steles.map((s) => ({
        steleId: s.id,
        title: s.title,
        status: 'pending',
        reason: '',
        pendingCompareIds: [],
      })),
      snapshot,
    };
    await db.packages.put(record);

    for (const stele of record.steles) {
      const result = await processStele(stele.steleId, snapshot);
      Object.assign(stele, result);
      record.status = deriveStatus(record.steles);
      await db.packages.put(record); // 进度逐条落库，中断后可续
    }

    await dispatch(loadCurrentPackage());
    return record;
  },
);

/** 重试失败项：只重试 status=failed 的碑刻，认好的留着不动 */
export const retryFailed = createAsyncThunk('verify/retryFailed', async (_payload, { dispatch, getState }) => {
  const record = (getState() as RootState).verify.current;
  if (!record) return null;
  for (const stele of record.steles) {
    if (stele.status !== 'failed') continue; // 只重试失败的那几块
    const result = await processStele(stele.steleId, record.snapshot);
    Object.assign(stele, result);
    record.status = deriveStatus(record.steles);
    await db.packages.put(record);
  }
  await dispatch(loadCurrentPackage());
  return record;
});

/** 清空当前核验包会话（不影响已认好的业务数据） */
export const clearCurrentPackage = createAsyncThunk('verify/clear', async (_payload, { dispatch, getState }) => {
  const record = (getState() as RootState).verify.current;
  if (record) await db.packages.delete(record.id);
  await dispatch(loadCurrentPackage());
});

const verifySlice = createSlice({
  name: 'verify',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(loadCurrentPackage.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadCurrentPackage.fulfilled, (state, action) => {
        state.current = action.payload;
        state.loading = false;
        state.error = '';
      })
      .addCase(loadCurrentPackage.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '核验包读取失败';
      })
      .addCase(receivePackage.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(receivePackage.fulfilled, (state, action) => {
        state.current = action.payload;
        state.loading = false;
      })
      .addCase(receivePackage.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '核验包接收失败';
      })
      .addCase(retryFailed.pending, (state) => {
        state.loading = true;
      })
      .addCase(retryFailed.fulfilled, (state, action) => {
        state.current = action.payload;
        state.loading = false;
      })
      .addCase(retryFailed.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '重试失败';
      })
      .addCase(clearCurrentPackage.fulfilled, (state) => {
        state.current = null;
      });
  },
});

export const selectVerifyState = (state: RootState): VerifyState => state.verify;
export const selectCurrentPackage = (state: RootState): VerifyPackageRecord | null => state.verify.current;

export default verifySlice.reducer;
