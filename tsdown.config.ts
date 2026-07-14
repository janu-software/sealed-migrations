import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  // Zero runtime dependencies: the SQL driver (mysql2, etc.) is supplied by the
  // consumer through the injected connection, so nothing needs bundling here.
})
