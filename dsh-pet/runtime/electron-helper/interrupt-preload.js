/**
 * 中断确认窗的 preload：只暴露「接收 payload」「上报尺寸」与「回答」三个原语。
 *
 * 不参与任何判定：窗口生命周期、超时、尺寸收口、答案回传都在 main.js。依赖 Electron 的
 * contextBridge/ipcRenderer，频道名必须与主进程逐字一致。
 *
 * @module dsh-pet/runtime/electron-helper/interrupt-preload
 */
const { contextBridge, ipcRenderer } = require('electron');

// 主进程在 dom-ready 就推 payload，页面脚本可能稍后才 onData：先缓存、补注册时立即补发，
// 否则「窗口弹出来了但标题/任务为空」。
const listeners = [];
let lastPayload = null;
ipcRenderer.on('interrupt:data', (_event, data) => {
  lastPayload = data;
  for (const cb of listeners) cb(data);
});

contextBridge.exposeInMainWorld('interruptBridge', {
  /** 主进程在页面加载完成后推一次 payload（id / reason / task / attempt / timeoutMs）。 */
  onData(cb) {
    listeners.push(cb);
    if (lastPayload) cb(lastPayload);
  },
  /** 页面量出的「气泡 + 外留白」尺寸（CSS px）：主进程据此把窗口收到刚好包住气泡。 */
  measure(size) {
    const w = Math.ceil(Number(size && size.w));
    const h = Math.ceil(Number(size && size.h));
    if (!(w > 0) || !(h > 0)) return;
    ipcRenderer.send('pet:interrupt-measure', { w, h });
  },
  /** 回答：'continue' = 继续未完成的工作；'no' = 暂不继续。 */
  answer(id, answer) {
    ipcRenderer.send('pet:interrupt-answer', { id, answer });
  },
});
