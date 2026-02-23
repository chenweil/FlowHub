import { defineConfig } from "vite";

export default defineConfig(async () => ({
  // Vite options tailored for Tauri development and specifically ignore the "src-tauri" directory
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));