export interface TTSContext {
  audioContext: AudioContext;
}

export interface TTSRequest {
  text: string;
  voiceOrLang: string; // e.g., 'gsw-CHE-gr' for Slang or dialect ID for FHNW
  speed?: number;
  pitch?: number;
}

export interface AudioQueueItem {
  id: string; // Unique ID for tracking
  blobUrl: string;
  text: string;
  duration?: number;
}

export interface TTSProvider {
  /**
   * Initialize the provider (e.g., connect to websocket, load resources)
   */
  initialize(): Promise<void>;

  /**
   * Synthesize text to audio.
   * Returns a URL (blob or remote) that can be played by an Audio element.
   */
  synthesize(request: TTSRequest): Promise<string>;
  
  /**
   * Clean up resources
   */
  dispose(): void;
}

export interface TranslationService {
  /**
   * Initialize the service
   */
  initialize(): Promise<void>;

  /**
   * Translate text from German to Swiss German dialect
   */
  translate(text: string, dialect: string): Promise<string>;
}
