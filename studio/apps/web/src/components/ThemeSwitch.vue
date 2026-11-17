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
/* Suite segmented control, variant B (roomy), as in Lamio Réglages. */
.theme-switch { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; padding: 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); }
.theme-switch button { min-height: 32px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: var(--ink-2); font-size: 12.5px; font-weight: 400; line-height: 1; white-space: nowrap; transition: background-color 150ms cubic-bezier(.4, 0, .2, 1), color 150ms ease, box-shadow 150ms ease; }
.theme-switch button:hover { color: var(--ink); }
.theme-switch button[aria-pressed="true"] { background: var(--surface); color: var(--ink); font-weight: 500; box-shadow: var(--shadow); }
.theme-switch button:focus-visible { outline: none; box-shadow: var(--suite-ring); }
@media (max-width: 1024px) { .theme-switch button { min-height: 40px; } }
</style>
