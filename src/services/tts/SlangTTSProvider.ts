import { TTSProvider, TTSRequest } from "../types";

export class SlangTTSProvider implements TTSProvider {
    // Use proxy path to avoid CORS issues; Vite proxies /api/slang to slang.slowsoft.ch
    private readonly apiUrl = "/api/slang/tts";

    async initialize(): Promise<void> {
        // Slang is a stateless REST API, so no persistent connection needed.
        return Promise.resolve();
    }

    async synthesize(request: TTSRequest): Promise<string> {
        try {
            const payload = {
                text: request.text,
                voiceorlang: request.voiceOrLang,
                speed: request.speed ?? 100,
                pitch: request.pitch ?? 100
            };

            console.log('[Slang TTS] Sending request:', JSON.stringify(payload));

            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'audio/wav'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`Slang TTS request failed: ${response.status} ${response.statusText}`);
            }

            const blob = await response.blob();
            return URL.createObjectURL(blob);

        } catch (error) {
            console.error("Slang TTS synthesis error:", error);
            throw error;
        }
    }

    dispose(): void {
        // Nothing to clean up
    }
}
