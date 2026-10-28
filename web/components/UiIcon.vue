<script setup lang="ts">
withDefaults(defineProps<{name:string;size?:number}>(),{size:18});
const paths:Record<string,string>={
 lab:'M8 3h8 M9 3v6L4 19q0 2 2 2h12q2 0 2-2l-5-10V3 M8 14h8',
 panel:'M3 4h18v16H3z M8 4v16',new:'M12 5v14 M5 12h14',search:'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
 work:'M9 5V3h6v2 M3 6h18v14H3z M3 11h18 M10 11v3h4v-3',
 incident:'M12 3 2 21h20z M12 9v5 M12 17v1',
 room:'M4 21V4h16v17 M8 8h2 M14 8h2 M8 12h2 M14 12h2 M10 21v-5h4v5',
 clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',check:'m5 13 4 4L19 7',
 send:'M3 3 22 12 3 21l4-9z M7 12h15',evidence:'M6 3h8l4 4v14H6z M9 12h6 M9 16h6',
 file:'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
 chat:'M4 4h16v12H9l-5 4z M8 8h8 M8 12h5',
 user:'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M4 21v-2a8 8 0 0 1 16 0v2',
 star:'m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z',
 more:'M5 12h.1 M12 12h.1 M19 12h.1',chevron:'m9 5 7 7-7 7',compare:'M8 3v18 M16 3v18 M4 6h8 M12 18h8',close:'m6 6 12 12 M18 6 6 18',
 settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
 palette:'M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h5a3 3 0 0 0 3-3c0-4-4-7-9-7 M7 8h.1 M11 6h.1 M16 7h.1 M5 12h.1',external:'M14 3h7v7 M21 3l-9 9 M10 4H4v16h16v-6',history:'M3 12a9 9 0 1 0 3-7 M3 3v6h6 M12 7v5l3 2'
};
</script>
<template><svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name]||paths.lab"/></svg></template>
