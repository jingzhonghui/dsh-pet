/**
 * 网页端异常中断确认卡（桌面 Helper 不可用时的回退）。
 *
 * 数据来源是 `/state` 的 `sections.interrupt`（host 写、host 清）；本组件只负责展示与回答，
 * 不判断「该不该续跑」——分类、次数、熔断都在 host 的 auto-continue 模块里。
 * 点击后乐观收起，真正的收起以 host 下一次写 null 为准。
 *
 * 注意：本仓库的 `h` 是 `h(type, props, key?)`，children 必须放在 props.children，
 * 不是 variadic children（与 React.createElement 不同）。
 *
 * @module dsh-pet/src/client/interrupt
 */
import type { ElementType, Key, ReactNode } from 'react';

import { postAction } from '../shared/state';

/** 与 host 的 InterruptPayload 同形（host 不 import shared，这里是消费侧声明）。 */
export interface InterruptPayload {
  id: string;
  sessionId: string;
  kind: 'error' | 'timeout' | 'max-tokens' | 'interrupted' | string;
  reason: string;
  task: string | null;
  via: 'desktop' | 'web';
  createdAt: number;
  timeoutMs: number;
  attempt: number;
  maxAttempts: number;
  test?: boolean;
}

/** 运行时注入的 React 能力；只声明本组件用到的部分。 */
export interface InterruptRuntime {
  h: (type: ElementType, props?: unknown, key?: Key) => ReactNode;
  useState: <T>(initial: T) => [T, (value: T) => void];
}

/** 卡片属性。 */
export interface InterruptCardProps {
  payload: InterruptPayload;
  onAnswer: (id: string, yes: boolean) => void;
}

/** 回答端点：与桌面弹框共用同一个 host 路由。 */
const ANSWER_URL = '/dsh-pet-7340/interrupt/answer';

/** 卡片根样式：固定在视口顶部居中，宠物通常在底部活动，卡片不遮宠物。 */
const CARD_STYLE = {
  position: 'fixed',
  top: '18px',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 2147483000,
  width: 'min(520px, calc(100vw - 32px))',
  pointerEvents: 'auto',
  background: '#ffffff',
  color: '#1f2329',
  border: '1px solid rgba(15, 23, 42, 0.12)',
  borderRadius: '14px',
  boxShadow: '0 18px 50px rgba(15, 23, 42, 0.22)',
  padding: '16px 18px 14px',
  fontFamily: "'Microsoft YaHei', 'PingFang SC', system-ui, sans-serif",
  userSelect: 'none',
} as const;

/**
 * 工厂：返回网页端确认卡组件。
 *
 * 卡片固定在视口顶部居中：宠物通常在底部活动，卡片不遮宠物；`pointer-events: auto`
 * 让它在 overlay 的穿透层上仍可点击。
 */
export function makeInterruptCard(rt: InterruptRuntime) {
  const { h, useState } = rt;

  return function InterruptCard({ payload, onAnswer }: InterruptCardProps) {
    const [sending, setSending] = useState(false);

    const answer = (yes: boolean): void => {
      if (sending) return;
      setSending(true);
      // 乐观收起：host 若因超时/已被别处回答而拒绝，下一次 /state 会把真实状态写回来。
      void postAction(ANSWER_URL, { id: payload.id, answer: yes ? 'continue' : 'no' });
      onAnswer(payload.id, yes);
    };

    const meta =
      payload.maxAttempts > 1
        ? `第 ${payload.attempt}/${payload.maxAttempts} 次续跑 · 长时间不处理会自动暂不继续`
        : '长时间不处理会自动暂不继续';

    return h('div', {
      role: 'alertdialog',
      'aria-live': 'assertive',
      'aria-label': '工作被异常中断',
      style: CARD_STYLE,
      children: [
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: '10px' },
          children: [
            h('span', {
              style: {
                flex: 'none',
                width: '32px',
                height: '32px',
                borderRadius: '9px',
                display: 'grid',
                placeItems: 'center',
                background: '#fff4e2',
                color: '#b56a00',
                fontSize: '18px',
                fontWeight: 700,
              },
              children: '!',
            }),
            h('div', {
              children: [
                h('div', { style: { fontSize: '15px', fontWeight: 700 }, children: '工作被异常中断' }),
                h('div', { style: { marginTop: '2px', fontSize: '12px', color: '#6b7280' }, children: meta }),
              ],
            }),
          ],
        }),
        h('div', {
          style: {
            marginTop: '12px',
            fontSize: '13px',
            lineHeight: 1.55,
            color: '#374151',
            wordBreak: 'break-word',
          },
          children: payload.reason,
        }),
        payload.task
          ? h('div', {
              style: {
                marginTop: '10px',
                padding: '8px 10px',
                borderRadius: '8px',
                background: '#f6f7f9',
                border: '1px solid #eceef2',
                fontSize: '12px',
                lineHeight: 1.45,
                color: '#5b6472',
              },
              children: `中断时记录的任务：${payload.task}`,
            })
          : null,
        h('div', {
          style: { marginTop: '14px', display: 'flex', justifyContent: 'flex-end', gap: '8px' },
          children: [
            h('button', {
              type: 'button',
              disabled: sending,
              onClick: () => answer(false),
              style: {
                border: 0,
                borderRadius: '8px',
                padding: '8px 14px',
                fontSize: '13px',
                fontFamily: 'inherit',
                cursor: sending ? 'default' : 'pointer',
                background: '#eef0f4',
                color: '#3f4756',
              },
              children: '暂不继续',
            }),
            h('button', {
              type: 'button',
              disabled: sending,
              onClick: () => answer(true),
              style: {
                border: 0,
                borderRadius: '8px',
                padding: '8px 14px',
                fontSize: '13px',
                fontFamily: 'inherit',
                fontWeight: 600,
                cursor: sending ? 'default' : 'pointer',
                background: '#2f6fed',
                color: '#ffffff',
              },
              children: '继续未完成的工作',
            }),
          ],
        }),
      ],
    });
  };
}
