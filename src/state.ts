import { setTimeout as sleep } from 'node:timers/promises';
import type { ProviderError } from './types.js';
import type { ProviderCfg } from './config.js';

/**
 * 健康屏蔽 + 配额计数 + 限速等待（D8：一个结构替代状态机）。
 * 每源只有 { blockedUntil, reason, failStreak }，到点自然放行，放行即试探；
 * 重复失败按初始时长 × 2^failStreak 阶梯翻倍封顶。
 */

export interface BlockedInfo {
  reason: string;
  remainS: number; // Infinity 表示 auth 长期摘除
}

interface PHealth {
  blockedUntilMs: number; // 0 = 未屏蔽；Infinity = auth
  reason: string;
  failStreak: number;
  lastError?: string;
}

/** 距上次请求不足 interval 时需要等待的毫秒数（0 = 无需等待） */
export function paceWaitMs(lastMs: number | undefined, intervalMs: number, now: number): number {
  if (lastMs === undefined) return 0;
  const elapsed = now - lastMs;
  return elapsed >= intervalMs ? 0 : intervalMs - elapsed;
}

export function paceIntervalMs(cfg: ProviderCfg): number {
  if (cfg.min_interval_ms) return cfg.min_interval_ms;
  if (cfg.local_qps) return Math.ceil(1000 / cfg.local_qps) + 50;
  return 0;
}

/** 该月 reset_day 的 00:00；reset_day 超过当月天数时 clamp 到月末（31 在 9 月 → 9/30），避免 JS Date 滚入下月 */
function monthStart(year: number, month: number, day: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay), 0, 0, 0, 0);
}

/** 当前计费窗口起点（用于配额计数的 period key） */
function windowStart(now: number, resetDay: number): Date {
  const d = new Date(now);
  const candidate = monthStart(d.getFullYear(), d.getMonth(), resetDay);
  return candidate.getTime() <= now ? candidate : monthStart(d.getFullYear(), d.getMonth() - 1, resetDay);
}

function periodKey(now: number, resetDay: number): string {
  return windowStart(now, resetDay).toISOString().slice(0, 10);
}

/** 各错误类别的初始屏蔽时长 */
const BASE_BLOCK_MS = { timeout: 30_000, network: 30_000, server_error: 60_000 } as const;

export interface BlockDefaults {
  cooldown_default_s: number;
  cooldown_max_s: number;
}

export class GatewayState {
  private health = new Map<string, PHealth>();
  private counters = new Map<string, { period: string; used: number }>();
  private lastPaceMs = new Map<string, number>();
  readonly startedAt = Date.now();

  private h(name: string): PHealth {
    let entry = this.health.get(name);
    if (!entry) {
      entry = { blockedUntilMs: 0, reason: '', failStreak: 0 };
      this.health.set(name, entry);
    }
    return entry;
  }

  checkBlocked(name: string, now = Date.now()): BlockedInfo | null {
    const h = this.health.get(name);
    if (!h || h.blockedUntilMs === 0) return null;
    if (Number.isFinite(h.blockedUntilMs) && now >= h.blockedUntilMs) return null;
    const remainMs = Number.isFinite(h.blockedUntilMs) ? h.blockedUntilMs - now : Number.MAX_SAFE_INTEGER;
    return { reason: h.reason, remainS: Math.ceil(remainMs / 1000) };
  }

  block(name: string, err: ProviderError, cfg: ProviderCfg, defaults: BlockDefaults, now = Date.now()): void {
    if (err.type === 'request_error' || err.type === 'no_results') return;
    const capMs = (cfg.cooldown_max_s ?? defaults.cooldown_max_s) * 1000;
    const h = this.h(name);
    h.reason = err.type;
    h.lastError = `${err.detail} at ${new Date(now).toISOString()}`;
    switch (err.type) {
      case 'rate_limited': {
        const base = err.retryAfterMs ?? defaults.cooldown_default_s * 1000;
        h.blockedUntilMs = now + Math.min(base, capMs);
        break;
      }
      case 'quota_exhausted': {
        // 上游恢复时间与本地计数窗口独立，不走失败阶梯或普通冷却上限。
        const resetAt = err.resetAtMs;
        h.blockedUntilMs = resetAt !== undefined && Number.isFinite(resetAt) && resetAt > now
          ? resetAt : now + cfg.quota_retry_s * 1000;
        break;
      }
      case 'auth_failure': {
        h.blockedUntilMs = Infinity;
        break;
      }
      case 'timeout':
      case 'network':
      case 'server_error': {
        const base = BASE_BLOCK_MS[err.type] * 2 ** h.failStreak;
        h.blockedUntilMs = now + Math.min(base, capMs);
        if (!err.soft) h.failStreak += 1;
        break;
      }
      default:
        break; // no_results 不会进入 block
    }
  }

  recordSuccess(name: string): void {
    const h = this.h(name);
    h.failStreak = 0;
    h.blockedUntilMs = 0;
    h.reason = '';
  }

  private counter(name: string, cfg: ProviderCfg, now: number) {
    const period = cfg.quota.type === 'monthly' ? periodKey(now, cfg.quota.reset_day ?? 1) : 'lifetime';
    let c = this.counters.get(name);
    if (!c || c.period !== period) {
      c = { period, used: 0 };
      this.counters.set(name, c);
    }
    return c;
  }

  used(name: string, cfg: ProviderCfg, now = Date.now()): number {
    return this.counter(name, cfg, now).used;
  }

  tryStart(name: string, cfg: ProviderCfg, now = Date.now()): boolean {
    const c = this.counter(name, cfg, now);
    if (cfg.quota.type !== 'unbounded' && cfg.quota.limit !== undefined && c.used >= cfg.quota.limit) return false;
    c.used++;
    return true;
  }

  quotaWarning(name: string, cfg: ProviderCfg): boolean {
    return cfg.quota.type !== 'unbounded' && cfg.quota.limit !== undefined
      && this.used(name, cfg) >= cfg.quota.limit * 0.9;
  }

  failStreak(name: string): number {
    return this.health.get(name)?.failStreak ?? 0;
  }

  lastError(name: string): string | undefined {
    return this.health.get(name)?.lastError;
  }

  /**
   * 限速等待：间隔不足则补齐（等待计入预算）。返回 false 表示预算内补不完，该跳跳过。
   */
  async pace(name: string, cfg: ProviderCfg, deadline: number, signal?: AbortSignal): Promise<boolean> {
    const interval = paceIntervalMs(cfg);
    // ponytail: 共享时间戳保证间隔，不保证 FIFO；确有公平性需求时再引入队列。
    for (;;) {
      signal?.throwIfAborted();
      const now = Date.now();
      if (now >= deadline) return false;
      const wait = paceWaitMs(this.lastPaceMs.get(name), interval, now);
      if (wait <= 0) {
        this.lastPaceMs.set(name, now);
        return true;
      }
      if (now + wait >= deadline) return false;
      await sleep(wait, undefined, { signal });
    }
  }
}
