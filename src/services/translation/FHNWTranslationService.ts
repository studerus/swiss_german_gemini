import { Client } from "@gradio/client";
import { TranslationService } from "../types";

export class FHNWTranslationService implements TranslationService {
    private client: Promise<Client> | null = null;
    private readonly apiUrl = "https://stt4sg.fhnw.ch/tts/";

    async initialize(): Promise<void> {
        if (!this.client) {
            try {
                this.client = Client.connect(this.apiUrl);
                await this.client; // Wait for connection
            } catch (error) {
                console.error("Failed to connect to FHNW Translation service:", error);
                this.client = null;
                throw error;
            }
        }
    }

    async translate(text: string, dialect: string): Promise<string> {
        if (!this.client) {
            await this.initialize();
        }

        try {
            const client = await this.client;
            if (!client) throw new Error("Client initialization failed");

            const response = (await client.predict("/translate_interface", {
                text_de: text,
                dialect: dialect,
            })) as { data: string }; // Adjust based on actual response structure if needed, currently observing data: string from App.tsx code study

            return response.data;
        } catch (error) {
            console.error("Translation error:", error);
            throw error;
        }
    }
}
