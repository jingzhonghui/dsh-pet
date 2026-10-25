/**
 * 异常中断自动续跑（host 半侧，纯逻辑，不 import src/shared）。
 *
 * 负责把 `turn/end` 的结束原因分类成「可续跑 / 不可续跑」，并为可续跑会话维护尝试次数、
 * 退避、熔断、去重与待确认弹框队列。副作用（写 /state、拉起桌面弹框、调用 Agent.followup）
 * 全部由调用方注入，本模块只产出决策，便于单测。
 *
 * 必须始终成立：
 * - aborted / blocked / forked 一律不动；`completed` 默认也当正常收尾，只有设置页开了
 *   「清单没干完也算中断」且本轮确实还有没做完的活（清单未清空 / 有工具没返回）才纳入。
 * - 自动续跑与弹框确认互斥：auto 为真时不弹框，auto 为假时才产生待确认项。
 * - 同一会话同一回合只处理一次；attempt 超过上限后不再自动重试。
 * - 续跑失败不允许把宿主拖死：所有异常由调用方收口，本模块只接收布尔结果。
 *
 * @module dsh-pet/src/host/auto-continue
 */

/** 可续跑的中断类别（用于文案与统计；不是所有类别都默认开启）。 */
export type ContinueKind = 'error' | 'timeout' | 'max-tokens' | 'interrupted' | 'unfinished';

/** `turn/end` 的 reason（宽松读取；DSH 低版本可能只有 kind）。 */
export interface TurnEndReason {
  kind?: string;
  error?: { message?: string; code?: string; status?: number } | string;
}

/** 分类结论；null = 不关心这条 turn/end。 */
export interface ClassifiedInterrupt {
  /** 是否允许进入续跑流程（仍受配置开关与尝试次数约束）。 */
  eligible: boolean;
  kind: ContinueKind;
  /** 可重试的瞬时故障（网络/限流/服务端），用于文案与「值不值得续」的判断。 */
  transient: boolean;
  /** 展示给用户的一句话原因（已截断，不含堆栈）。 */
  reason: string;
}

/** 待用户确认 / 正在自动续跑的中断项（写进 sections.interrupt 的形状）。 */
export interface InterruptPayload {
  /** 稳定 id：同一会话同一回合只有一条。 */
  id: string;
  sessionId: string;
  kind: ContinueKind;
  reason: string;
  /** 中断时最近一条 todo 文案（可 null）。 */
  task: string | null;
  /** 由哪一端负责确认：desktop = 桌面 Helper 弹框；web = 页面内卡片。 */
  via: 'desktop' | 'web';
  createdAt: number;
  /** 弹框自动超时（ms）；超时按「暂不继续」处理。 */
  timeoutMs: number;
  /** 当前是第几次尝试（从 1 开始）。 */
  attempt: number;
  maxAttempts: number;
  /** 测试弹框：回答「继续」也不会真的续跑。 */
  test?: boolean;
}

/** 续跑请求（调用方真正去调用 Agent.followup）。 */
export interface ContinueRequest {
  sessionId: string;
  payload: InterruptPayload;
  attempt: number;
}

/** 调度器最小接口：测试可注入假定时器，生产用 setTimeout。 */
export interface Scheduler {
  schedule(fn: () => void, delayMs: number): () => void;
}

/** 本模块需要的宿主能力（全部由 index.ts 注入，模块本身不碰 Electron / Agent）。 */
export interface AutoContinueHooks {
  /** 写 sections.interrupt（null = 清空）。 */
  publish: (payload: InterruptPayload | null) => void;
  /** 让常驻桌面 Helper 弹确认框；返回 false 表示桌面端不可用。 */
  askDesktop: (payload: InterruptPayload) => boolean;
  /** 待确认项被别处回答/取消时，让桌面 Helper 收起同 id 的弹框（可缺省）。 */
  dismissDesktop?: (id: string) => void;
  /** 真正续跑；true = 已成功把消息排进 Agent。 */
  continueSession: (request: ContinueRequest) => Promise<boolean>;
  /** 给用户一条可见反馈（复用现有通知通道）。 */
  notify: (text: string) => void;
  /** 当前时间（测试注入）。 */
  now?: () => number;
  /** 定时器（测试注入）。 */
  scheduler?: Scheduler;
}

/** 运行配置（来自 main 配置，已填满默认值）。 */
export interface AutoContinueConfig {
  enabled: boolean;
  maxAttempts: number;
  delayMs: number;
  dialogTimeoutMs: number;
  allowTruncated: boolean;
  /** `completed` 是否也纳入（「正常结束但活没干完」）：默认开，设置页可关。 */
  allowCompleted: boolean;
}

/**
 * `completed` 的额外判据。
 *
 * 光看 reason 分不出来「真收尾」和「模型说了句话就停」——两者都是 completed。所以只在这一轮
 * **还有没做完的活**时才认为可疑：清单里仍有 in_progress/pending 项，或有工具调用发出后没等到结果
 * （回合被打断在工具执行中间）。没有这个信号就一律当正常收尾，否则每条回复都会弹一次确认框。
 */
export interface CompletedRule {
  /** 设置页开关：completed 是否参与判定。 */
  allow: boolean;
  /** 回合结束时是否还有未完成的活。 */
  hasOpenWork: boolean;
}

/** 瞬时故障的状态码：408/409/425/429 与 5xx。 */
const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524]);

/** 瞬时故障的常见 code（大小写不敏感，兼容各家 provider）。 */
const TRANSIENT_CODES = new Set([
  'TRANSPORT',
  'TIMEOUT',
  'RATE_LIMIT',
  'SERVER',
  'EMPTY_RESPONSE',
  'OVERLOADED',
  'UNAVAILABLE',
  'NETWORK',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);

/** 文案里出现这些片段时按「可能是瞬时故障」处理（provider 只给 message 时兜底）。 */
const TRANSIENT_MESSAGE =
  /timeout|timed out|econnreset|econnrefused|etimedout|socket hang up|fetch failed|network|rate limit|too many requests|overloaded|temporarily unavailable|service unavailable|bad gateway|gateway timeout|\b(429|500|502|503|504)\b/i;

/** 展示原因的最大长度（码点）：弹框与通知都只放一句话。 */
const REASON_MAX = 120;

/** 截断到 REASON_MAX 个码点，避免代理对被截成半个字符。 */
function clip(text: string): string {
  const points = Array.from(text.trim());
  return points.length > REASON_MAX ? `${points.slice(0, REASON_MAX).join('')}…` : points.join('');
}

/** 从 reason.error 里取展示原因；没有就退回 kind。 */
function errorText(reason: TurnEndReason): string {
  const error = reason.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const message = String(error.message ?? '').trim();
    if (message) return message;
    const code = String(error.code ?? '').trim();
    if (code) return code;
  }
  return String(reason.kind ?? '未知错误');
}

/**
 * 把一条 `turn/end` 的 reason 分类。
 *
 * - `aborted` / `blocked` / `forked` / 未知 → null（不碰）。
 * - `completed`：默认 null；只有 `completed.allow` 且这一轮还有没做完的活（见 CompletedRule）
 *   才当成 `unfinished` 纳入，其余一律当正常收尾。
 * - `error`：只有状态码 / code / message 命中瞬时故障白名单才 eligible；认证类
 *   （401/403/400/上下文超限/内容过滤）一律不自动续，只通知用户修配置。
 * - `timeout`：按瞬时故障处理。
 * - `max-tokens`：默认关，`allowTruncated` 为真时才 eligible。
 * - `interrupted`：崩溃恢复，eligible，但由调用方做「每次启动最多一条」的限流。
 */
export function classifyTurnEnd(
  reason: TurnEndReason | null,
  allowTruncated: boolean,
  completed?: CompletedRule,
): ClassifiedInterrupt | null {
  if (!reason) return null;
  const kind = String(reason.kind ?? '');
  if (!kind) return null;
  if (kind === 'completed') {
    if (!completed?.allow || !completed.hasOpenWork) return null;
    return {
      eligible: true,
      kind: 'unfinished',
      transient: false,
      reason: '回合正常结束，但清单里还有未完成的事项',
    };
  }
  if (kind === 'aborted' || kind === 'blocked' || kind === 'forked') return null;

  if (kind === 'max-tokens') {
    return {
      eligible: allowTruncated,
      kind: 'max-tokens',
      transient: false,
      reason: '输出达到长度上限，回答被截断',
    };
  }
  if (kind === 'interrupted') {
    return { eligible: true, kind: 'interrupted', transient: false, reason: '上次运行异常退出，工作可能未完成' };
  }
  if (kind === 'timeout') {
    return { eligible: true, kind: 'timeout', transient: true, reason: '请求超时，服务商未在预期时间内返回' };
  }
  if (kind !== 'error') return null;

  const error = reason?.error;
  const status = error && typeof error === 'object' ? Number(error.status) : NaN;
  const code = error && typeof error === 'object' ? String(error.code ?? '').toUpperCase() : '';
  const text = errorText(reason);
  const transient =
    (Number.isFinite(status) && TRANSIENT_STATUS.has(status)) ||
    (code !== '' && TRANSIENT_CODES.has(code)) ||
    TRANSIENT_MESSAGE.test(text);

  return {
    eligible: transient,
    kind: 'error',
    transient,
    reason: clip(transient ? text : `${text}（认证/请求类错误，不自动续跑）`),
  };
}

/** 默认调度器：setTimeout + unref（不把宿主进程钉住）。 */
const defaultScheduler: Scheduler = {
  schedule(fn, delayMs) {
    const timer = setTimeout(fn, Math.max(0, delayMs));
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/** 当前时间。 */
function defaultNow(): number {
  return Date.now();
}

/**
 * 自动续跑状态机。
 *
 * 调用顺序（index.ts 的 session/event 监听）：
 *   onTurnStart / onUserMessage → onTurnEnd（记录并决定是否续跑）→ answer（弹框回答）。
 * 所有定时器都登记在 `timers`，dispose 时统一取消，避免插件卸载后还去写 S 或调用 Agent。
 */
export class AutoContinueStore {
  declare private readonly hooks: AutoContinueHooks;
  declare private readonly now: () => number;
  declare private readonly scheduler: Scheduler;
  /** 会话 → 已尝试次数（completed 或真实用户消息后清零）。 */
  declare private readonly attempts: Map<string, number>;
  /** 已处理过的回合（`sessionId:seq` / `sessionId:ts`），防重复弹框。 */
  declare private readonly handled: Set<string>;
  /** 当前待确认项（一次只展示一条，后到覆盖先到）。 */
  declare private pending: InterruptPayload | null;
  /** 待确认项的自动超时取消函数。 */
  declare private pendingTimer: (() => void) | null;
  /** 已排期但尚未执行的自动续跑（会话 → 取消函数）。 */
  declare private readonly scheduled: Map<string, () => void>;
  /** 最近一次续跑的时间戳（熔断用，10 分钟窗口）。 */
  declare private readonly recentContinues: number[];
  /** 熔断截止时间（0 = 未熔断）。 */
  declare private pausedUntil: number;
  /** 本进程启动后已因 interrupted 续跑过的次数（限流：最多 1 次）。 */
  declare private interruptedContinued: number;
  /** 配置快照（每次 onTurnEnd 由调用方刷新，设置页改完立即生效）。 */
  declare private config: AutoContinueConfig;

  constructor(hooks: AutoContinueHooks, config: AutoContinueConfig) {
    this.hooks = hooks;
    this.now = hooks.now ?? defaultNow;
    this.scheduler = hooks.scheduler ?? defaultScheduler;
    this.attempts = new Map();
    this.handled = new Set();
    this.pending = null;
    this.pendingTimer = null;
    this.scheduled = new Map();
    this.recentContinues = [];
    this.pausedUntil = 0;
    this.interruptedContinued = 0;
    this.config = config;
  }

  /** 更新配置（每次事件前调用，保证设置页改完立即生效）。 */
  setConfig(config: AutoContinueConfig): void {
    this.config = config;
  }

  /** 当前待确认项（测试 / 观测用）。 */
  pendingInterrupt(): InterruptPayload | null {
    return this.pending;
  }

  /** 回合开始：取消上一回合遗留的排期与待确认项（用户已经动过手，旧提示不再有意义）。 */
  onTurnStart(sessionId: string): void {
    this.cancelScheduled(sessionId);
    if (this.pending?.sessionId === sessionId) this.clearPending();
  }

  /** 真实用户消息（source.kind 不是 auto-continue/goal）：清零尝试次数并取消待续跑。 */
  onUserMessage(sessionId: string, sourceKind: string | undefined): void {
    if (sourceKind === 'auto-continue' || sourceKind === 'goal') return;
    this.attempts.delete(sessionId);
    this.cancelScheduled(sessionId);
    if (this.pending?.sessionId === sessionId) this.clearPending();
  }

  /**
   * 回合结束：分类 + 去重 + 决定自动续跑还是弹框。
   *
   * @param sessionId 会话 id
   * @param reason turn/end 的 reason
   * @param task 最近 todo 文案（可 null）
   * @param seq 事件序号（没有就用时间戳兜底）
   * @param hasOpenWork 回合结束时是否还有未完成的活（清单未完成项 / 未返回的工具调用）
   */
  onTurnEnd(
    sessionId: string,
    reason: TurnEndReason | null,
    task: string | null,
    seq?: number,
    hasOpenWork = false,
  ): void {
    const kind = String(reason?.kind ?? '');
    const classified = classifyTurnEnd(reason, this.config.allowTruncated, {
      allow: this.config.allowCompleted,
      hasOpenWork,
    });
    if (kind === 'completed') {
      // 真·收尾才清账：次数清零、撤掉排期、收起这一条的待确认项。
      // 被判成「正常结束但没干完」时不清：否则计数每次都被自己清零，等于绕过熔断。
      if (!classified?.eligible) {
        this.attempts.delete(sessionId);
        this.cancelScheduled(sessionId);
        if (this.pending?.sessionId === sessionId) this.clearPending();
        return;
      }
    }
    if (!classified?.eligible) return;

    // interrupted 是崩溃恢复：一次启动最多自动续一次，避免把上次退出前的会话全部拉起来。
    if (classified.kind === 'interrupted') {
      if (this.interruptedContinued >= 1) return;
    }

    const key = `${sessionId}:${seq !== undefined && seq > 0 ? seq : this.now()}`;
    if (this.handled.has(key)) return;
    this.handled.add(key);

    const attempt = (this.attempts.get(sessionId) ?? 0) + 1;
    if (attempt > this.config.maxAttempts) {
      this.hooks.notify(`「${classified.reason}」已连续中断 ${this.config.maxAttempts} 次，停止自动续跑。`);
      return;
    }

    const payload: InterruptPayload = {
      id: key,
      sessionId,
      kind: classified.kind,
      reason: classified.reason,
      task,
      via: 'web',
      createdAt: this.now(),
      timeoutMs: this.config.dialogTimeoutMs,
      attempt,
      maxAttempts: this.config.maxAttempts,
    };

    if (this.config.enabled) {
      this.scheduleContinue(sessionId, payload);
      return;
    }
    this.raise(payload);
  }

  /** 弹框回答。yes = 继续；no = 暂不继续。 */
  answer(id: string, yes: boolean): boolean {
    const pending = this.pending;
    if (!pending || pending.id !== id) return false;
    this.clearPending();
    if (pending.test) {
      this.hooks.notify(yes ? '测试弹框：已选择继续（不会真正续跑）。' : '测试弹框：已选择暂不继续。');
      return true;
    }
    if (!yes) {
      this.hooks.notify('已暂停自动续跑；需要时再发送一条消息即可继续。');
      return true;
    }
    this.startContinue(pending);
    return true;
  }

  /** 设置页「测试中断弹框」：走完整弹框链路，但回答不会真的续跑。 */
  test(): InterruptPayload {
    const payload: InterruptPayload = {
      id: `test:${this.now()}`,
      sessionId: 'test',
      kind: 'error',
      reason: '示例：服务商连接中断（测试弹框，不会真正续跑）',
      task: null,
      via: 'web',
      createdAt: this.now(),
      timeoutMs: this.config.dialogTimeoutMs,
      attempt: 1,
      maxAttempts: this.config.maxAttempts,
      test: true,
    };
    this.raise(payload);
    return this.pending ?? payload;
  }

  /** 插件卸载：取消全部定时器并清空待确认项。 */
  dispose(): void {
    for (const cancel of this.scheduled.values()) cancel();
    this.scheduled.clear();
    this.clearPending();
  }

  /** 产生待确认项：先问桌面 Helper，桌面不可用才回落到页面内卡片。 */
  private raise(payload: InterruptPayload): void {
    if (this.pending) this.clearPending();
    const desktop = this.hooks.askDesktop(payload);
    payload.via = desktop ? 'desktop' : 'web';
    this.pending = payload;
    this.hooks.publish(payload);
    this.pendingTimer = this.scheduler.schedule(() => {
      this.pendingTimer = null;
      if (this.pending?.id === payload.id) this.answer(payload.id, false);
    }, payload.timeoutMs);
  }

  /** 清掉待确认项：取消超时、让桌面弹框收起、写 null 让网页卡片收起。 */
  private clearPending(): void {
    if (this.pendingTimer) {
      this.pendingTimer();
      this.pendingTimer = null;
    }
    const had = this.pending;
    this.pending = null;
    if (had) {
      try {
        this.hooks.dismissDesktop?.(had.id);
      } catch {
        /* 桌面端已退出：忽略 */
      }
      this.hooks.publish(null);
    }
  }

  /** 自动模式：延迟续跑；期间用户发消息 / 新回合会取消。
   *  延迟按尝试次数指数退避（5s → 10s → 20s…，上限 120s）：provider 抖动时给恢复留时间，
   *  也避免同一故障在几秒内被反复重试。 */
  private scheduleContinue(sessionId: string, payload: InterruptPayload): void {
    this.cancelScheduled(sessionId);
    const delay = Math.min(this.config.delayMs * 2 ** Math.max(0, payload.attempt - 1), 120_000);
    const cancel = this.scheduler.schedule(() => {
      this.scheduled.delete(sessionId);
      if (this.pausedUntil > this.now()) {
        this.hooks.notify('自动续跑已因连续失败暂停，稍后再试。');
        return;
      }
      this.startContinue(payload);
    }, delay);
    this.scheduled.set(sessionId, cancel);
  }

  /** 真正发起续跑（自动模式与用户点「继续」共用）。 */
  private startContinue(payload: InterruptPayload): void {
    const now = this.now();
    if (this.pausedUntil > now) {
      this.hooks.notify('自动续跑已因连续失败暂停，稍后再试。');
      return;
    }

    // 熔断：10 分钟内超过 5 次续跑 → 暂停 10 分钟。只看发起次数，不依赖模型结果，
    // 因为 provider 持续故障时每次续跑都会立刻失败，必须有一个跨会话的总闸。
    while (this.recentContinues.length > 0 && now - this.recentContinues[0] > 10 * 60 * 1000) {
      this.recentContinues.shift();
    }
    this.recentContinues.push(now);
    if (this.recentContinues.length > 5) {
      this.pausedUntil = now + 10 * 60 * 1000;
      this.hooks.notify('自动续跑连续触发过多，已暂停 10 分钟。');
      return;
    }

    this.attempts.set(payload.sessionId, payload.attempt);
    if (payload.kind === 'interrupted') this.interruptedContinued += 1;

    void this.hooks
      .continueSession({ sessionId: payload.sessionId, payload, attempt: payload.attempt })
      .then((ok) => {
        if (!ok) this.hooks.notify('自动续跑未能发起：会话可能已关闭，请手动继续。');
      })
      .catch(() => {
        this.hooks.notify('自动续跑失败：会话可能已关闭，请手动继续。');
      });
  }

  /** 取消某会话已排期的续跑。 */
  private cancelScheduled(sessionId: string): void {
    const cancel = this.scheduled.get(sessionId);
    if (!cancel) return;
    cancel();
    this.scheduled.delete(sessionId);
  }
}

/**
 * 续跑提示词：让模型先对齐现状再继续，避免重复已完成的工作。
 * 任务文案只作提示，不要求模型盲信（它可能已经过时）。
 *
 * `kind` 只影响第一句：`unfinished` 是「回合正常结束但活没干完」，说成「网络异常中断」会误导模型
 * 去重试请求，而不是接着干活。
 */
export function continuationPrompt(task: string | null, kind?: ContinueKind): string {
  const lines = [
    kind === 'unfinished'
      ? '上一轮结束时清单里还有未完成的事项，这一轮被判定为「没干完」而不是已收尾。'
      : '上一条回复因服务商/网络异常中断，任务可能尚未完成。',
    '请先检查当前工作区和任务进度，确认已经完成的部分，然后从中断处继续完成剩余工作。',
    '不要重复已经完成的操作，也不要重新开始；如果已经全部完成，请直接给出最终结论。',
  ];
  if (task) lines.push(`中断时记录的任务：${task}`);
  return lines.join('\n');
}
