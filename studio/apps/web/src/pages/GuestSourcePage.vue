<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type { GuestRoomState, GuestSession } from '@gabin/shared';
import { guestApi } from '../guests/guestApi';
import { GuestConnection } from '../guests/guestConnection';
const props = defineProps<{ token: string }>();
const video = ref<HTMLVideoElement>(); const stream = shallowRef<MediaStream | null>(null); const room = shallowRef<GuestRoomState | null>(null);
const session = shallowRef<GuestSession | null>(null); const error = ref(''); let connection: GuestConnection | null = null;
let disposed = false;
let displayRevision = 0;
async function show(value: MediaStream | null): Promise<void> {
  const revision = ++displayRevision; stream.value = value; await nextTick();
  if (!video.value || revision !== displayRevision || disposed) return;
  if (video.value.srcObject !== value) video.value.srcObject = value;
  if (!value) { connection?.setLocalReady(false); return; }
  try { await video.value.play(); if (revision === displayRevision && !disposed) { connection?.setLocalReady(true); error.value = ''; } }
  catch { if (revision === displayRevision && !disposed) { error.value = 'La source navigateur OBS n’autorise pas la lecture audio.'; connection?.setLocalReady(false); } }
}
onMounted(async () => {
  try {
    const key = `nino.guest.source:${props.token}`; const cached = sessionStorage.getItem(key);
    let next: GuestSession;
    try { next = cached ? await guestApi<GuestSession>('resume', { token: cached }) : await guestApi<GuestSession>('source', { token: props.token }); }
    catch (failure) { if (cached) sessionStorage.removeItem(key); throw failure; }
    if (next.role !== 'source') throw new Error('Ce lien n’est pas une source OBS.');
    if (disposed) return;
    session.value = next; sessionStorage.setItem(key, next.token); room.value = next.room;
    connection = new GuestConnection(next, null, { room: value => { room.value = value; if (!value.guests.some(guest => guest.id === next.guestId && guest.admitted && guest.joined)) void show(null); }, stream: (_peer, value) => { void show(value); }, status: (_message, connected) => { if (!connected) void show(null); }, error: message => { error.value = message; void show(null); } });
    await connection.start();
  } catch (failure) { error.value = failure instanceof Error ? failure.message : 'La source invité est indisponible.'; }
});
onBeforeUnmount(() => { disposed = true; void connection?.close(); });
</script>
<template><main class="guest-source"><video ref="video" autoplay playsinline /><div v-if="!stream" class="guest-source-placeholder"><span>{{ session?.name ?? 'Invité à distance' }}</span><small>{{ error || 'En attente de l’invité' }}</small></div></main></template>
