<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
const props = defineProps<{ open: boolean; title: string; confirmLabel: string; busy?: boolean; dangerous?: boolean }>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
watch(() => props.open, async open => {
  await nextTick();
  if (open && !dialog.value?.open) dialog.value?.showModal();
  else if (!open && dialog.value?.open) dialog.value.close();
}, { immediate: true });
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="confirm-dialog" aria-labelledby="confirm-title" @cancel.prevent="!busy && emit('cancel')">
      <h2 id="confirm-title">{{ title }}</h2>
      <div class="dialog-copy"><slot /></div>
      <div class="actions end">
        <button class="button" :disabled="busy" autofocus @click="emit('cancel')">Annuler</button>
        <button class="button" :class="dangerous ? 'danger' : 'primary'" :disabled="busy" @click="emit('confirm')">{{ busy ? 'Confirmation par OBS…' : confirmLabel }}</button>
      </div>
    </dialog>
  </Teleport>
</template>
