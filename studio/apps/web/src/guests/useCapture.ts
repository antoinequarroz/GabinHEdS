import { onBeforeUnmount, ref, shallowRef } from 'vue';
import { captureError } from './guestApi';

export function useCapture() {
  const stream = shallowRef<MediaStream | null>(null);
  const devices = ref<MediaDeviceInfo[]>([]);
  const camera = ref(''); const microphone = ref(''); const captureBusy = ref(false); const error = ref('');
  const secure = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  let disposed = false;
  function stop(): void { stream.value?.getTracks().forEach(track => track.stop()); stream.value = null; }
  async function open(): Promise<MediaStream | null> {
    error.value = '';
    if (!secure) { error.value = 'La caméra et le micro demandent une adresse HTTPS. Ouvrez le lien sécurisé fourni par la salle.'; return null; }
    if (captureBusy.value) return null; captureBusy.value = true;
    stop();
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: { ...(camera.value ? { deviceId: { exact: camera.value } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 25, max: 30 } },
        audio: { ...(microphone.value ? { deviceId: { exact: microphone.value } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (disposed) { next.getTracks().forEach(track => track.stop()); return null; }
      stream.value = next; devices.value = await navigator.mediaDevices.enumerateDevices();
      camera.value = next.getVideoTracks()[0]?.getSettings().deviceId ?? camera.value;
      microphone.value = next.getAudioTracks()[0]?.getSettings().deviceId ?? microphone.value;
      return next;
    } catch (failure) { error.value = captureError(failure); return null; }
    finally { captureBusy.value = false; }
  }
  onBeforeUnmount(() => { disposed = true; stop(); });
  return { stream, devices, camera, microphone, captureBusy, error, secure, open, stop };
}
