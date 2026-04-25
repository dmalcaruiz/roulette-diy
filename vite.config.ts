import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Cross-Origin-Opener-Policy must permit the parent to read `window.closed`
// on the Google sign-in popup; otherwise Firebase Auth can't detect when
// the popup completes, which surfaces as a Cross-Origin-Opener-Policy
// console warning AND eventually as auth/popup-blocked because Google's
// heuristics flag the parent as broken. `same-origin-allow-popups` keeps
// the host isolated from other tabs while permitting popup-window access.
const authFriendlyHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: authFriendlyHeaders },
  preview: { headers: authFriendlyHeaders },
});
