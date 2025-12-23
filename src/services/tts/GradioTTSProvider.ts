import { Client } from "@gradio/client";
import { TTSProvider, TTSRequest } from "../types";

export class GradioTTSProvider implements TTSProvider {
    private client: Promise<Client> | null = null;
    private readonly apiUrl = "https://stt4sg.fhnw.ch/tts/";

    async initialize(): Promise<void> {
        if (!this.client) {
            try {
                this.client = Client.connect(this.apiUrl);
                await this.client;
            } catch (error) {
                console.error("Failed to connect to FHNW Gradio TTS service:", error);
                this.client = null;
                throw error;
            }
        }
    }

    async synthesize(request: TTSRequest): Promise<string> {
        if (!this.client) {
            await this.initialize();
        }

        try {
            const client = await this.client;
            if (!client) throw new Error("Client initialization failed");

            // FHNW expects 'edited_text' and 'dialect'
            const response = (await client.predict("/speech_interface", {
                edited_text: request.text,
                dialect: request.voiceOrLang,
            })) as any;

            // The FHNW API returns a list of files/data. Based on App.tsx analysis:
            // response.data[0] contains { url: string, ... }
            // The Gradio client handles the file upload/download, giving us a URL.

            const audioData = response.data?.[0];
            if (!audioData?.url) {
                throw new Error("No audio URL returned from FHNW service");
            }

            // We might need to fetch the blob if the URL is not directly playable or protected,
            // but App.tsx suggests it tries to fetch it to create a blob URL.
            // Let's mimic App.tsx: fetch -> blob -> objectUrl
            return await this.createAudioBlobUrl(audioData.url);

        } catch (error) {
            console.error("Gradio TTS synthesis error:", error);
            throw error;
        }
    }

    private async createAudioBlobUrl(audioUrl: string): Promise<string> {
        try {
            // Check if it's already a full URL or relative
            // Gradio client usually gives full URLs or relative to root.
            const response = await fetch(audioUrl, {
                mode: 'cors',
                credentials: 'include'
            });
            const blob = await response.blob();
            return URL.createObjectURL(blob);
        } catch (error) {
            console.error('Error creating blob URL:', error);
            // Fallback to original URL if fetch fails? 
            // App.tsx logic suggests valid fallback, so we return the original if blob creation fails 
            // (though in App.tsx it throws). Let's stick to returning a playable URL.
            return audioUrl;
        }
    }

    dispose(): void {
        // Gradio client doesn't have an explicit disconnect/dispose method exposed easily 
        // without looking deeper, but we can nullify the reference.
        this.client = null;
    }
}
