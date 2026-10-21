import { defineConfig } from 'vite';
import { notespaceData } from './server/dataPlugin';

export default defineConfig({
  plugins: [notespaceData()],
  server: {
    // Space files are data, not source: changes to them are pushed as `notespace:changed`
    // events instead of triggering a full page reload.
    // Build output (the Rust target folder alone is thousands of files) is not source either.
    watch: { ignored: ['**/data/backups/**', '**/src-tauri/target/**', '**/dist/**'] },
  },
});
