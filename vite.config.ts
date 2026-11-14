import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'SUISSE_SPEECH_');
  const suisseSpeechProxy = {
    target: 'https://api.suisse-speech.ch',
    changeOrigin: true,
    secure: true,
    ws: true,
    headers: { 'X-API-Key': env.SUISSE_SPEECH_API_KEY || '' },
    rewrite: (path: string) => path.replace(/^\/api\/suisse-speech/, '/v1'),
  };
  return {
    plugins: [react()],
    server: {
      open: true, // Browser automatisch öffnen
      port: 5173,  // Standard-Port von Vite
      proxy: {
        '/api/suisse-speech/tts/stream': suisseSpeechProxy,
        '/api/suisse-speech/stt/stream': suisseSpeechProxy,
        '/api/slang': {
          target: 'https://slang.slowsoft.ch',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/slang/, '/webslang'),
          secure: true,
        }
      }
    },
    preview: {
      proxy: {
        '/api/suisse-speech/tts/stream': suisseSpeechProxy,
        '/api/suisse-speech/stt/stream': suisseSpeechProxy
      }
    }
  };
})
