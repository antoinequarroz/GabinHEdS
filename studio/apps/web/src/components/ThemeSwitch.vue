<script setup lang="ts">
import { themeChoices, useTheme } from '../composables/useTheme';
const { theme, setTheme } = useTheme();
</script>

<template>
  <div class="theme-switch" role="group" aria-label="Apparence">
    <button v-for="choice in themeChoices" :key="choice.id" type="button" :aria-pressed="theme === choice.id" @click="setTheme(choice.id)">{{ choice.label }}</button>
  </div>
</template>

<style scoped>
.theme-switch { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2px; padding: 2px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface-2); }
.theme-switch button { min-height: 32px; padding: 4px 6px; border: 0; border-radius: 6px; background: transparent; color: var(--ink-2); font-size: 11px; font-weight: 500; }
.theme-switch button:hover { color: var(--ink); }
.theme-switch button[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
</style>
