<script setup>
// Adapted from kapi-css (https://gitee.com/kappi/kapi-css, Apache-2.0) daySlide.vue
// Scaled for toolbar integration with crisp inline SVG stars and full keyboard accessibility.
defineProps({
  modelValue: {
    type: String,
    default: 'light',
  },
})

const emit = defineEmits(['update:modelValue'])

const toggleTheme = (current) => {
  emit('update:modelValue', current === 'dark' ? 'light' : 'dark')
}
</script>

<template>
  <button
    class="theme-switch"
    :class="{ 'theme-switch--dark': modelValue === 'dark' }"
    type="button"
    role="switch"
    :aria-checked="modelValue === 'dark'"
    :aria-label="modelValue === 'dark' ? '切换为浅色模式' : '切换为深色模式'"
    :title="modelValue === 'dark' ? '深色模式（点击切换为浅色）' : '浅色模式（点击切换为深色）'"
    @click="toggleTheme(modelValue)"
  >
    <span class="theme-switch__track" aria-hidden="true">
      <span class="theme-switch__sky">
        <span />
        <span />
        <span />
      </span>

      <span class="theme-switch__back-clouds">
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
      </span>

      <span class="theme-switch__front-clouds">
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
      </span>

      <span class="theme-switch__stars">
        <svg class="theme-switch__star theme-switch__star--1" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 1L14.8 9.2L23 12L14.8 14.8L12 23L9.2 14.8L1 12L9.2 9.2Z" />
        </svg>
        <svg class="theme-switch__star theme-switch__star--2" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 1L14.8 9.2L23 12L14.8 14.8L12 23L9.2 14.8L1 12L9.2 9.2Z" />
        </svg>
        <svg class="theme-switch__star theme-switch__star--3" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 1L14.8 9.2L23 12L14.8 14.8L12 23L9.2 14.8L1 12L9.2 9.2Z" />
        </svg>
        <svg class="theme-switch__star theme-switch__star--4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 1L14.8 9.2L23 12L14.8 14.8L12 23L9.2 14.8L1 12L9.2 9.2Z" />
        </svg>
        <svg class="theme-switch__star theme-switch__star--5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 1L14.8 9.2L23 12L14.8 14.8L12 23L9.2 14.8L1 12L9.2 9.2Z" />
        </svg>
        <svg class="theme-switch__star theme-switch__star--6" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 1L14.8 9.2L23 12L14.8 14.8L12 23L9.2 14.8L1 12L9.2 9.2Z" />
        </svg>
      </span>

      <span class="theme-switch__orb">
        <span />
        <span />
        <span />
      </span>
    </span>
  </button>
</template>
