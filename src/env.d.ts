/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GEMINI_API_KEY: string
  readonly VITE_AZURE_SPEECH_KEY: string
  readonly VITE_AZURE_SPEECH_REGION: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
} 