<script setup lang="ts">
defineProps<{ name: string }>();
const paths: Record<string, string> = {
  projects: 'M3 7h7l2 2h9v11H3z M3 7V4h7l2 3',
  plus: 'M12 5v14 M5 12h14',
  room: 'M4 21V3h16v18 M8 21v-4h8v4 M8 7h2 M14 7h2 M8 11h2 M14 11h2',
  devices: 'M5 3h14v18H5z M11 18h2',
  record: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16',
  check: 'M5 12l4 4L19 6',
  warning: 'M12 3L2 21h20z M12 9v5 M12 17v.01',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  back: 'M19 12H5 M11 6l-6 6 6 6',
  mic: 'M9 4a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 10v1a7 7 0 0 0 14 0v-1 M12 18v4 M8 22h8',
  movie: 'M3 4h18v16H3z M7 4v16 M17 4v16 M3 9h4 M3 15h4 M17 9h4 M17 15h4',
  slides: 'M3 3h18v13H3z M12 16v5 M7 21h10 M7 7h10 M7 11h6',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 15v6h16v-6',
  settings: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  camera: 'M3 7h4l2-3h6l2 3h4v13H3z M12 9a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
  headphones: 'M4 15v-3a8 8 0 0 1 16 0v3 M4 14h3v7H4z M17 14h3v7h-3z',
  close: 'M6 6l12 12 M6 18L18 6',
  pause: 'M8 4v16 M16 4v16',
  play: 'M6 3l15 9-15 9z',
  stop: 'M5 5h14v14H5z',
  mark: 'M5 22V3h14l-3 5 3 5H5',
  edit: 'M4 20l4-1L20 7l-3-3L5 16z M14 7l3 3',
  link: 'M10 14l4-4 M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
  broadcast: 'M12 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2 M7 7a7 7 0 0 0 0 10 M17 7a7 7 0 0 1 0 10 M3 3a13 13 0 0 0 0 18 M21 3a13 13 0 0 1 0 18',
};
</script>

<template><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] ?? paths.record" /></svg></template>
