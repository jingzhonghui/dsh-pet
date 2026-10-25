/**
 * auto-continue 纯逻辑单测：分类、弹框/自动互斥、次数上限、去重、熔断、interrupted 限流。
 * 不碰 Electron / Agent / 文件系统：所有副作用都走注入的假 hooks。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AutoContinueStore,
  classifyTurnEnd,
  continuationPrompt,
  type AutoContinueConfig,
  type ContinueRequest,
  type InterruptPayload,
  type Scheduler,
} from './auto-continue';

/** 可手动推进的假调度器：记录延迟与取消，`runAll` 按登记顺序执行。 */
function fakeScheduler(): Scheduler & { runAll(): void; delays(): number[]; pending(): number } {
  const items: Array<{ fn: () => void; delay: number; cancelled: boolean }> = [];
  return {
    schedule(fn, delay) {
      const item = { fn, delay, cancelled: false };
      items.push(item);
      return () => {
        item.cancelled = true;
      };
    },
    runAll() {
      for (const item of items.splice(0)) if (!item.cancelled) item.fn();
    },
    delays() {
      return items.map((i) => i.delay);
    },
    pending() {
      return items.filter((i) => !i.cancelled).length;
    },
  };
}

/** 一套记录型 hooks + 可控时钟。 */
function harness(config: Partial<AutoContinueConfig> = {}) {
  let now = 1_000_000;
  const scheduler = fakeScheduler();
  const published: Array<InterruptPayload | null> = [];
  const notes: string[] = [];
  const continued: ContinueRequest[] = [];
  const dismissed: string[] = [];
  let desktop = false;
  let ok = true;
  const store = new AutoContinueStore(
    {
      publish: (p) => published.push(p),
      askDesktop: () => desktop,
      dismissDesktop: (id) => dismissed.push(id),
      continueSession: async (req) => {
        continued.push(req);
        return ok;
      },
      notify: (text) => notes.push(text),
      now: () => now,
      scheduler,
    },
    {
      enabled: false,
      maxAttempts: 3,
      delayMs: 5000,
      dialogTimeoutMs: 90_000,
      allowTruncated: false,
      allowCompleted: true,
      ...config,
    },
  );
  return {
    store,
    scheduler,
    published,
    notes,
    continued,
    dismissed,
    setDesktop: (v: boolean) => {
      desktop = v;
    },
    setOk: (v: boolean) => {
      ok = v;
    },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

test('classifyTurnEnd：瞬时故障可续，认证/请求类不可续', () => {
  assert.equal(classifyTurnEnd({ kind: 'completed' }, false), null);
  assert.equal(classifyTurnEnd({ kind: 'aborted' }, false), null);
  assert.equal(classifyTurnEnd({ kind: 'blocked' }, false), null);
  assert.equal(classifyTurnEnd({ kind: 'forked' }, false), null);
  assert.equal(classifyTurnEnd(null, false), null);

  const e503 = classifyTurnEnd({ kind: 'error', error: { status: 503, message: 'upstream down' } }, false);
  assert.equal(e503?.eligible, true);
  assert.equal(e503?.transient, true);

  const e429 = classifyTurnEnd({ kind: 'error', error: { status: 429 } }, false);
  assert.equal(e429?.eligible, true);

  const eReset = classifyTurnEnd({ kind: 'error', error: { message: 'read ECONNRESET' } }, false);
  assert.equal(eReset?.eligible, true);

  const eAuth = classifyTurnEnd({ kind: 'error', error: { status: 401, message: 'invalid key' } }, false);
  assert.equal(eAuth?.eligible, false);
  assert.match(eAuth?.reason ?? '', /不自动续跑/);

  const eBad = classifyTurnEnd({ kind: 'error', error: { status: 400, message: 'bad request' } }, false);
  assert.equal(eBad?.eligible, false);

  // 只给 message 的 provider：网络片段兜底；纯业务错误不兜底
  assert.equal(classifyTurnEnd({ kind: 'error', error: 'socket hang up' }, false)?.eligible, true);
  assert.equal(classifyTurnEnd({ kind: 'error', error: 'content filter triggered' }, false)?.eligible, false);
});

test('classifyTurnEnd：timeout 可续，max-tokens 默认关、显式开才可续', () => {
  assert.equal(classifyTurnEnd({ kind: 'timeout' }, false)?.eligible, true);
  assert.equal(classifyTurnEnd({ kind: 'max-tokens' }, false)?.eligible, false);
  assert.equal(classifyTurnEnd({ kind: 'max-tokens' }, true)?.eligible, true);
  assert.equal(classifyTurnEnd({ kind: 'interrupted' }, false)?.eligible, true);
});

test('classifyTurnEnd：completed 默认不动，开了「清单没干完也算中断」且确有未完成的活才纳入', () => {
  // 没开：completed 一律当正常收尾
  assert.equal(classifyTurnEnd({ kind: 'completed' }, false, { allow: false, hasOpenWork: true }), null);
  // 开了但没有未完成的活（清单全绿 / 没有挂起的工具调用）：照样不动，否则每条回复都会弹一次
  assert.equal(classifyTurnEnd({ kind: 'completed' }, false, { allow: true, hasOpenWork: false }), null);
  // 不传第三参（老调用方）保持原语义
  assert.equal(classifyTurnEnd({ kind: 'completed' }, false), null);

  const c = classifyTurnEnd({ kind: 'completed' }, false, { allow: true, hasOpenWork: true });
  assert.equal(c?.eligible, true);
  assert.equal(c?.kind, 'unfinished');
  assert.equal(c?.transient, false);
  assert.match(c?.reason ?? '', /未完成/);
});

test('completed + 没干完：走弹框；点继续才续跑，且不把这一轮的计数清零', () => {
  const h = harness({ enabled: false });
  h.store.onTurnEnd('s1', { kind: 'completed' }, '第二步', 10, true);

  const pending = h.store.pendingInterrupt();
  assert.equal(pending?.kind, 'unfinished');
  assert.equal(pending?.attempt, 1);
  assert.equal(h.continued.length, 0);

  assert.equal(h.store.answer(pending!.id, true), true);
  assert.equal(h.continued.length, 1);
  // 提示词要说清「没干完」，不能误导成网络重试
  assert.match(h.continued[0].payload.reason, /未完成/);

  // 第二条：次数累加到 2（说明上一轮没被当成正常收尾清账）
  h.store.onTurnEnd('s1', { kind: 'completed' }, '第二步', 11, true);
  assert.equal(h.store.pendingInterrupt()?.attempt, 2);
});

test('completed 且真收尾：清账（次数清零、排期取消、待确认项收起）', () => {
  const h = harness({ enabled: true, delayMs: 5000 });
  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, '修 bug', 1);
  assert.equal(h.scheduler.pending(), 1); // 已排期续跑
  // 这一轮没干完的活已经没有了 → 视为正常收尾：排期取消，不产生待确认项
  h.store.onTurnEnd('s1', { kind: 'completed' }, '修 bug', 2, false);
  assert.equal(h.scheduler.pending(), 0);
  assert.equal(h.store.pendingInterrupt(), null);
});

test('关闭自动续跑：产生待确认项，选「继续」才调用 followup', () => {
  const h = harness({ enabled: false });
  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 502 } }, '修 bug', 7);

  const pending = h.store.pendingInterrupt();
  assert.ok(pending);
  assert.equal(pending?.via, 'web');
  assert.equal(pending?.task, '修 bug');
  assert.equal(h.published[h.published.length - 1]?.id, pending?.id);
  assert.equal(h.continued.length, 0);

  assert.equal(h.store.answer(pending!.id, true), true);
  assert.equal(h.continued.length, 1);
  assert.equal(h.continued[0].sessionId, 's1');
  assert.equal(h.published[h.published.length - 1], null); // 收起卡片
});

test('关闭自动续跑：选「暂不继续」不调用 followup', () => {
  const h = harness();
  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, 1);
  const id = h.store.pendingInterrupt()!.id;
  assert.equal(h.store.answer(id, false), true);
  assert.equal(h.continued.length, 0);
  assert.equal(h.store.pendingInterrupt(), null);
  assert.deepEqual(h.dismissed, [id], '桌面弹框要按 id 收起');
  assert.ok(h.notes.some((n) => n.includes('已暂停')));
});

test('桌面 Helper 可用时 via=desktop；不可用时回退 web', () => {
  const h = harness();
  h.setDesktop(true);
  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, 1);
  assert.equal(h.store.pendingInterrupt()?.via, 'desktop');
});

test('开启自动续跑：不弹框，延迟到点才 followup，用户先发言可取消', () => {
  const h = harness({ enabled: true, delayMs: 5000 });
  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, 1);
  assert.equal(h.store.pendingInterrupt(), null);
  assert.equal(h.continued.length, 0);
  assert.deepEqual(h.scheduler.delays(), [5000]);

  h.store.onUserMessage('s1', 'user');
  h.scheduler.runAll();
  assert.equal(h.continued.length, 0);

  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, 2);
  h.scheduler.runAll();
  assert.equal(h.continued.length, 1);
});

test('自动续跑按指数退避：5s → 10s → 20s', () => {
  const h = harness({ enabled: true, maxAttempts: 3, delayMs: 5000 });
  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, 1);
  assert.deepEqual(h.scheduler.delays(), [5000]);
  h.scheduler.runAll();
  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, 2);
  assert.deepEqual(h.scheduler.delays(), [10_000]);
  h.scheduler.runAll();
  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, 3);
  assert.deepEqual(h.scheduler.delays(), [20_000]);
});

test('次数上限：同一会话达到 maxAttempts 后停止并通知', () => {
  const h = harness({ enabled: true, maxAttempts: 2, delayMs: 0 });
  for (let i = 0; i < 2; i++) {
    h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, i + 1);
    h.scheduler.runAll();
  }
  assert.equal(h.continued.length, 2);

  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, 3);
  h.scheduler.runAll();
  assert.equal(h.continued.length, 2);
  assert.ok(h.notes.some((n) => n.includes('停止自动续跑')));
});

test('completed 清零尝试次数，允许下一轮重新计数', () => {
  const h = harness({ enabled: true, maxAttempts: 1, delayMs: 0 });
  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, 1);
  h.scheduler.runAll();
  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, 2);
  h.scheduler.runAll();
  assert.equal(h.continued.length, 1);

  h.store.onTurnEnd('s1', { kind: 'completed' }, null, 3);
  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, 4);
  h.scheduler.runAll();
  assert.equal(h.continued.length, 2);
});

test('去重：同一会话同一 seq 只处理一次', () => {
  const h = harness();
  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, 9);
  const first = h.store.pendingInterrupt();
  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, 9);
  assert.equal(h.store.pendingInterrupt()?.id, first?.id);
  assert.equal(h.published.filter((p) => p !== null).length, 1);
});

test('熔断：10 分钟内发起超过 5 次后续跑暂停', () => {
  const h = harness({ enabled: true, maxAttempts: 10, delayMs: 0 });
  for (let i = 0; i < 6; i++) {
    h.store.onTurnEnd(`s${i}`, { kind: 'error', error: { status: 503 } }, null, i + 1);
    h.scheduler.runAll();
  }
  assert.equal(h.continued.length, 5);
  assert.ok(h.notes.some((n) => n.includes('暂停 10 分钟')));
});

test('interrupted 每次启动最多自动续一次', () => {
  const h = harness({ enabled: true, delayMs: 0 });
  h.store.onTurnEnd('s1', { kind: 'interrupted' }, null, 1);
  h.scheduler.runAll();
  assert.equal(h.continued.length, 1);

  h.store.onTurnEnd('s2', { kind: 'interrupted' }, null, 2);
  h.scheduler.runAll();
  assert.equal(h.continued.length, 1);
});

test('弹框超时按暂不继续处理', () => {
  const h = harness({ dialogTimeoutMs: 1000 });
  h.store.onTurnEnd('s1', { kind: 'error', error: { status: 503 } }, null, 1);
  assert.ok(h.store.pendingInterrupt());
  h.advance(1000);
  h.scheduler.runAll();
  assert.equal(h.store.pendingInterrupt(), null);
  assert.equal(h.continued.length, 0);
});

test('测试弹框回答继续也不会真的续跑', () => {
  const h = harness();
  const pending = h.store.test();
  assert.equal(pending.test, true);
  h.store.answer(pending.id, true);
  assert.equal(h.continued.length, 0);
  assert.ok(h.notes.some((n) => n.includes('测试弹框')));
});

test('continuationPrompt 带任务提示且不重复要求重启', () => {
  const text = continuationPrompt('修复登录超时');
  assert.match(text, /从中断处继续/);
  assert.match(text, /修复登录超时/);
  assert.match(text, /不要重复已经完成的操作/);
});
