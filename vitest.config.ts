import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // picocolors enables color when CI is set, which breaks assertions on plain output.
    env: { NO_COLOR: '1' },
  },
})
