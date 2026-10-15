import { watch, onBeforeUnmount, type Ref } from 'vue';

/** Readiness expires unless the browser continues presenting actual video frames. */
export function videoHeartbeat(element: Ref<HTMLVideoElement | undefined>, frame: () => void): void {
  let cancel = () => {};
  watch(element, value => {
    cancel();
    if (!value) return;
    let active = true; let id = 0; let lastTime = -1; let timer: ReturnType<typeof setInterval> | undefined;
    if (value.requestVideoFrameCallback) {
      const next = () => { if (!active) return; frame(); id = value.requestVideoFrameCallback(next); };
      id = value.requestVideoFrameCallback(next);
    } else {
      timer = setInterval(() => { if (value.readyState >= 2 && value.currentTime !== lastTime && !value.paused) { lastTime = value.currentTime; frame(); } }, 500);
    }
    cancel = () => { active = false; if (id) value.cancelVideoFrameCallback(id); clearInterval(timer); };
  }, { immediate: true });
  onBeforeUnmount(() => cancel());
}
