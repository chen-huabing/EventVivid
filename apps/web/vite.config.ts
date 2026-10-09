import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()], server: { host: true, port: 5175, strictPort: true, headers: { 'Cache-Control': 'no-store, max-age=0' } } });
