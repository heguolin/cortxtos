<script setup lang="ts">
defineProps<{ title: string; ticket: string }>()
</script>

<template>
  <div class="mx-auto max-w-2xl rounded-2xl border border-edge bg-panel p-8">
    <h2 class="text-xl font-bold">{{ title }}</h2>
    <p class="mt-3 text-sm leading-6 text-ink-dim">
      此页面由 {{ ticket }} 交付。骨架与导航已就绪，登录态已生效。
    </p>
  </div>
</template>
