import { useState, useRef, useEffect, useCallback, memo, useMemo } from 'react';
import { Box, Container, TextField, IconButton, Paper, Typography, List, ListItem, ListItemText, CircularProgress, Select, MenuItem, FormControl, InputLabel, Switch, FormControlLabel } from '@mui/material';
import { Send as SendIcon, VolumeUp, VolumeOff, Mic, MicOff, AddCircleOutline } from '@mui/icons-material';
import { streamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createGroq } from '@ai-sdk/groq';
import * as speechsdk from 'microsoft-cognitiveservices-speech-sdk';



interface ModelSettings {
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
}

type ProviderId = 'google' | 'openai' | 'groq';

interface ModelConfig {
  id: string;
  name: string;
}

interface ProviderConfig {
  id: ProviderId;
  name: string;
  models: ModelConfig[];
}

const AVAILABLE_PROVIDERS: ProviderConfig[] = [
  {
    id: 'google',
    name: 'Google Gemini',
    models: [
      // Gemini 2.5 Series (Latest - June 2025)
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (recommended)' },
      { id: 'gemini-2.5-flash-preview-09-2025', name: 'Gemini 2.5 Flash Preview' },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' },
      { id: 'gemini-2.5-flash-lite-preview-09-2025', name: 'Gemini 2.5 Flash-Lite Preview' },
      // Gemini 2.0 Series
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
      { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash Experimental' },
      { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash-Lite' },
      // Gemini 1.5 Series (Legacy)
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash (Legacy)' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro (Legacy)' },
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    models: [
      // --- GPT-5 Series ---
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-5-pro', name: 'GPT-5 Pro' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
      { id: 'gpt-5-nano', name: 'GPT-5 Nano' },
      // --- GPT-4 Series ---
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
      { id: 'gpt-4', name: 'GPT-4' },
      // --- Open-Weight Series ---
      { id: 'gpt-oss-120b', name: 'GPT-OSS 120B' },
      { id: 'gpt-oss-20b', name: 'GPT-OSS 20B' },
      // --- Preview & Specialized ---
      { id: 'gpt-4o-search-preview', name: 'GPT-4o Search (Preview)' },
      { id: 'gpt-4o-mini-search-preview', name: 'GPT-4o Mini Search (Preview)' },
      // --- Legacy ---
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
    ]
  },
  {
    id: 'groq',
    name: 'Groq',
    models: [
      // Production
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B (recommended)' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B' },
      { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B' },
      { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B' },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B' },
      { id: 'gemma2-9b-it', name: 'Gemma 2 9B' },
      // Systems
      { id: 'groq/compound', name: 'Groq Compound (System)' },
      { id: 'groq/compound-mini', name: 'Groq Compound Mini (System)' },
      // Preview
      { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick 17B (Preview)' },
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B (Preview)' },
      { id: 'moonshotai/kimi-k2-instruct-0905', name: 'Kimi K2 Instruct (Preview)' },
      { id: 'qwen/qwen3-32b', name: 'Qwen3 32B (Preview)' },
    ]
  }
];

const AVAILABLE_DIALECTS = [
  { id: 'Aargau', name: 'Aargauerdeutsch' },
  { id: 'Bern', name: 'Berndeutsch' },
  { id: 'Basel', name: 'Baseldeutsch' },
  { id: 'Graubünden', name: 'Graubündnerdeutsch' },
  { id: 'Luzern', name: 'Luzernerdeutsch' },
  { id: 'St. Gallen', name: 'St. Gallerdeutsch' },
  { id: 'Valais', name: 'Walliserdeutsch' },
  { id: 'Zürich', name: 'Zürichdeutsch' }
] as const;

import { FHNWTranslationService } from './services/translation/FHNWTranslationService';
import { GradioTTSProvider } from './services/tts/GradioTTSProvider';
import { SlangTTSProvider } from './services/tts/SlangTTSProvider';
import { TTSProvider, TranslationService } from './services/types';

// ... (existing imports)

const SLANG_VOICE_MAPPING: Record<string, string> = {
  'Aargau': 'gsw-CHE-zh', // Fallback
  'Bern': 'gsw-CHE-be',
  'Basel': 'gsw-CHE-ba',
  'Graubünden': 'gsw-CHE-gr',
  'Luzern': 'gsw-CHE-lu',
  'St. Gallen': 'gsw-CHE-sg',
  'Valais': 'gsw-CHE-be', // Fallback
  'Zürich': 'gsw-CHE-zh'
};

// ... (existing constants)

interface AudioQueueItem {
  text: string;
  blobUrl: string; // Changed from audioData object to direct blobUrl
  sequence: number;
}

// Memoized Message Component for better performance
interface MessageItemProps {
  message: { text: string; isUser: boolean };
  isTemporary: boolean;
}

const MessageItem = memo(({ message, isTemporary }: MessageItemProps) => {
  return (
    <ListItem
      sx={{
        justifyContent: message.isUser ? 'flex-end' : 'flex-start',
        mb: 1,
      }}
    >
      <Paper
        elevation={1}
        sx={{
          p: 2,
          maxWidth: '70%',
          backgroundColor: message.isUser ? 'primary.light' : 'grey.100',
          color: message.isUser ? 'white' : 'text.primary',
          whiteSpace: 'pre-wrap',
          opacity: isTemporary ? 0.7 : 1,
          fontStyle: isTemporary ? 'italic' : 'normal',
        }}
      >
        <ListItemText primary={message.text} />
      </Paper>
    </ListItem>
  );
});

MessageItem.displayName = 'MessageItem';

function App() {
  const [messages, setMessages] = useState<Array<{ text: string; isUser: boolean }>>([]);
  const messagesRef = useRef<Array<{ text: string; isUser: boolean }>>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>('groq');
  const [selectedModel, setSelectedModel] = useState<string>('llama-3.3-70b-versatile');
  const [isSpeechEnabled, setIsSpeechEnabled] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // API Keys for different providers
  const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
  const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY || '';
  const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY || '';
  const SPEECH_KEY = import.meta.env.VITE_AZURE_SPEECH_KEY || '';
  const SPEECH_REGION = import.meta.env.VITE_AZURE_SPEECH_REGION || '';

  // Create provider instances with API keys (memoized to avoid recreation on every render)
  const google = useMemo(() => createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY }), [GEMINI_API_KEY]);
  const openai = useMemo(() => createOpenAI({ apiKey: OPENAI_API_KEY }), [OPENAI_API_KEY]);
  const groq = useMemo(() => createGroq({ apiKey: GROQ_API_KEY }), [GROQ_API_KEY]);

  const [isListening, setIsListening] = useState(false);
  const recognizer = useRef<speechsdk.SpeechRecognizer | null>(null);
  const [isRecognizing, setIsRecognizing] = useState(false);
  const isRecognizingRef = useRef(false);
  const [modelSettings, setModelSettings] = useState<ModelSettings>({
    systemPrompt: `Du bist ein freundlicher Roboter namens Hans. Du funktionierst so, dass du durch speech to text in Realzeit transkribiertes Audio als Input bekommst.
Es kann sein, dass Inputs falsch transkribiert werden. Falls du also zusammenhangslos wirkende Inputs bekommst, frage nach, ob du es richtig verstanden hast.`,
    maxTokens: 500,
    temperature: 0.7
  });
  const [ttsProviderName, setTtsProviderName] = useState<'gradio' | 'slang'>('gradio');
  const ttsProviderNameRef = useRef<'gradio' | 'slang'>('gradio');

  // Services
  const translationService = useRef<TranslationService>(new FHNWTranslationService());
  const ttsProviders = useRef<{ gradio: TTSProvider, slang: TTSProvider }>({
    gradio: new GradioTTSProvider(),
    slang: new SlangTTSProvider()
  });
  const [selectedDialect, setSelectedDialect] = useState<string>("Basel");
  const selectedDialectRef = useRef<string>("Basel");
  const audioQueue = useRef<AudioQueueItem[]>([]);
  const isPlayingAudioRef = useRef<boolean>(false);
  const nextSequenceNumberRef = useRef<number>(0);
  const sentencesToProcess = useRef<Array<{
    text: string;
    sequence: number;
  }>>([]);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const firstSentenceTimeRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Keep refs in sync with state
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    ttsProviderNameRef.current = ttsProviderName;
  }, [ttsProviderName]);

  useEffect(() => {
    selectedDialectRef.current = selectedDialect;
  }, [selectedDialect]);

  // Helper function to get the model instance based on provider
  const getModelInstance = () => {
    switch (selectedProvider) {
      case 'google':
        return google(selectedModel);
      case 'openai':
        return openai(selectedModel);
      case 'groq':
        return groq(selectedModel);
      default:
        return google(selectedModel);
    }
  };

  const cleanTextForSpeech = (text: string) => {
    return text
      .replace(/\*([^*]*)\*/g, '$1') // Entferne Sternchen
      .replace(/\s+/g, ' ') // Normalisiere Whitespace
      .trim();
  };

  const debugLog = (message: string, ...data: any[]) => {
    console.log(`[TTS Debug] ${message}`, ...data);
  };

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


  const playNextInQueue = async () => {
    if (audioQueue.current.length === 0) {
      console.log('[TTS Debug] Audio queue empty, stopping playback');
      isPlayingAudioRef.current = false;
      return;
    }

    try {
      while (audioQueue.current.length > 0) {
        const nextItem = audioQueue.current.shift();
        if (!nextItem) break;

        // Messung der Zeit bis zum ersten Satz
        if (nextItem.sequence === 0 && firstSentenceTimeRef.current === null) {
          firstSentenceTimeRef.current = performance.now();
          console.log(`[TTS Debug] First sentence playback started in ${Math.round(firstSentenceTimeRef.current - startTimeRef.current)}ms`);
        }

        console.log('[TTS Debug] Playing item, sequence:', nextItem.sequence, nextItem.text);
        let actualPlayableUrl: string | null = null;
        if (nextItem.blobUrl) {
          actualPlayableUrl = nextItem.blobUrl;
        }

        if (!actualPlayableUrl) {
          debugLog('No valid URL, skipping');
          continue;
        }

        const audio = audioPlayerRef.current;
        if (!audio) {
          debugLog('Audioplayer not initialized, skipping');
          continue;
        }

        audio.src = actualPlayableUrl;

        // Warten, bis das Audio zu Ende gespielt wurde
        await new Promise<void>((resolve) => {
          audio.onended = () => {
            if (actualPlayableUrl?.startsWith("blob:")) {
              // Optionally revoke, but maybe keep for replay or handle in separate cleanup
              // For now, let's revoke to avoid memory leaks
              URL.revokeObjectURL(actualPlayableUrl);
            }
            resolve();
          };
          audio.onerror = (e) => {
            console.error('Audio playback error:', e);
            resolve();
          };
          audio.play().catch(playErr => {
            console.error('Error while playing audio:', playErr);
            resolve();
          });
        });

        // Optional: Kurze Pause zwischen den Sätzen
        await delay(100);
      }
    } catch (err) {
      console.error('playNextInQueue error:', err);
    } finally {
      isPlayingAudioRef.current = false;
      if (audioQueue.current.length > 0) {
        isPlayingAudioRef.current = true;
        playNextInQueue();
      }
    }
  };

  const stopSpeech = () => {
    // Stoppe aktuelle Audiowiedergabe
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
    }

    // Leere die Queues
    audioQueue.current = [];
    sentencesToProcess.current = [];

    // Reset des Playback-Status
    isPlayingAudioRef.current = false;
  };


  const handleProviderChange = useCallback((event: any) => {
    const newProvider = event.target.value as ProviderId;
    setSelectedProvider(newProvider);
    // Set default model for the new provider
    const defaultModel = AVAILABLE_PROVIDERS.find(p => p.id === newProvider)?.models[0].id || '';
    setSelectedModel(defaultModel);
    setMessages([]); // Clear chat history on provider change
  }, []);

  const handleModelChange = useCallback((event: any) => {
    setSelectedModel(event.target.value);
  }, []);

  const handleSend = async (messageText?: string) => {
    const textToSend = messageText || input.trim();

    if (!textToSend) return;

    // Check if API key is available for the selected provider
    const apiKey = selectedProvider === 'google' ? GEMINI_API_KEY :
      selectedProvider === 'openai' ? OPENAI_API_KEY :
        selectedProvider === 'groq' ? GROQ_API_KEY : '';

    if (!apiKey) {
      console.error(`API key for ${selectedProvider} not configured`);
      return;
    }

    // Only stop speech if audio is actually playing
    if (isPlayingAudioRef.current) {
      stopSpeech();
    }
    setInput('');

    // Add user message to UI
    setMessages(prevMessages => [...prevMessages, { text: textToSend, isUser: true }]);
    setIsLoading(true);

    try {
      // Add empty assistant message
      setMessages(prevMessages => [...prevMessages, { text: '', isUser: false }]);

      // Build messages array for the AI SDK - use ref to get latest messages
      const conversationMessages: Array<{ role: 'system' | 'user' | 'assistant', content: string }> = [
        { role: 'system', content: modelSettings.systemPrompt },
        ...messagesRef.current.map(msg => ({
          role: msg.isUser ? 'user' as const : 'assistant' as const,
          content: msg.text
        })),
        { role: 'user', content: textToSend }
      ];

      // Reset all relevant variables
      firstSentenceTimeRef.current = null;
      startTimeRef.current = performance.now();
      nextSequenceNumberRef.current = 0; // Reset sequence counter
      let firstSentenceReceivedTime: number | null = null;
      let fullResponse = '';
      let currentBuffer = '';

      // Use AI SDK streamText
      const result = await streamText({
        model: getModelInstance(),
        messages: conversationMessages,
        maxTokens: modelSettings.maxTokens,
        temperature: modelSettings.temperature,
        onError: ({ error }) => {
          console.error('Error during streaming:', error);
          setMessages(prev => {
            const newMessages = [...prev.slice(0, -1)]; // remove the empty message placeholder
            const errorMessage = error instanceof Error ? error.message : String(error);
            return [...newMessages, { text: `Fehler: ${errorMessage}`, isUser: false }];
          });
        },
      });

      let firstSentenceSent = false;
      let firstSentenceContent = '';

      for await (const chunk of result.textStream) {
        fullResponse += chunk;

        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1] = {
            text: fullResponse,
            isUser: false
          };
          return newMessages;
        });

        currentBuffer += chunk;

        const currentProvider = ttsProviderNameRef.current;

        // Progressive sentence splitting logic
        if (currentProvider === 'gradio') {
          // Gradio (FHNW): Split everything for lowest latency
          const { sentences, remainder } = extractSentences(currentBuffer);
          if (sentences.length > 0) {
            if (firstSentenceReceivedTime === null) {
              firstSentenceReceivedTime = performance.now();
              console.log(`[TTS Debug] First sentence received in ${Math.round(firstSentenceReceivedTime - startTimeRef.current)}ms`);
            }
            sentences.forEach(s => generateAndQueueTTS(s));
          }
          currentBuffer = remainder;
        } else if (!firstSentenceSent) {
          // Slang: Only split the FIRST sentence to start playback quickly
          const { sentences, remainder } = extractSentences(currentBuffer);
          if (sentences.length > 0) {
            firstSentenceContent = sentences[0];
            generateAndQueueTTS(firstSentenceContent);
            firstSentenceSent = true;
            currentBuffer = remainder; // Not strictly needed but keeps it clean

            if (firstSentenceReceivedTime === null) {
              firstSentenceReceivedTime = performance.now();
              console.log(`[TTS Debug] First sentence (Slang) received in ${Math.round(firstSentenceReceivedTime - startTimeRef.current)}ms`);
            }
          }
        }
      }

      // Final processing
      const finalProvider = ttsProviderNameRef.current;
      if (finalProvider === 'gradio') {
        if (currentBuffer.trim()) {
          generateAndQueueTTS(currentBuffer.trim());
          currentBuffer = '';
        }
      } else {
        // For Slang
        if (!firstSentenceSent) {
          // Response was too short to have a sentence boundary, or just one sentence
          if (fullResponse.trim()) {
            generateAndQueueTTS(fullResponse.trim());
          }
        } else {
          // Send the rest of the response as one single chunk for better quality
          const rest = fullResponse.slice(fullResponse.indexOf(firstSentenceContent) + firstSentenceContent.length).trim();
          if (rest) {
            generateAndQueueTTS(rest);
          }
        }
      }
    } catch (error) {
      console.error('Error:', error);
      setMessages(prev => [...prev, { text: 'Es tut mir leid, es ist ein Fehler aufgetreten.', isUser: false }]);
    } finally {
      setIsLoading(false);
    }
  };

  // Event handlers memoized for performance
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
  }, []);

  const handleKeyPress = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleClick = useCallback(() => {
    handleSend();
  }, [handleSend]);

  const handleNewChat = useCallback(() => {
    setMessages([]);
    messagesRef.current = [];
  }, []);

  const handleMicrophoneToggle = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      initializeRecognizer();
    } else {
      stopListening();
    }
  }, []);

  const handleSpeechToggle = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setIsSpeechEnabled(e.target.checked);
  }, []);

  const initializeRecognizer = async () => {
    try {
      // Stelle sicher, dass der vorherige Recognizer sauber beendet wird
      if (recognizer.current) {
        await new Promise<void>((resolve) => {
          recognizer.current?.stopContinuousRecognitionAsync(
            () => {
              try {
                recognizer.current?.close();
              } catch (err) {
                console.warn('Fehler beim Schließen des Recognizers:', err);
              }
              recognizer.current = null;
              resolve();
            },
            (err) => {
              console.warn('Fehler beim Stoppen der Erkennung:', err);
              recognizer.current = null;
              resolve();
            }
          );
        });
      }

      if (!SPEECH_KEY || !SPEECH_REGION) {
        console.error('Speech Credentials nicht konfiguriert');
        return;
      }

      try {
        const speechConfig = speechsdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);
        speechConfig.speechRecognitionLanguage = "de-CH";

        const audioConfig = speechsdk.AudioConfig.fromDefaultMicrophoneInput();
        const newRecognizer = new speechsdk.SpeechRecognizer(speechConfig, audioConfig);

        // Events konfigurieren
        newRecognizer.recognizing = (_, e) => {
          if (e.result.text) {
            console.log(`ERKENNE: ${e.result.text}`);

            // Stop speech only if audio is playing and this is the first recognition
            if (!isRecognizingRef.current && isPlayingAudioRef.current) {
              stopSpeech();
            }

            // Update or create temporary user message with partial result
            setMessages(prev => {
              const newMessages = [...prev];
              // Check if last message is a temporary recognizing message
              if (newMessages.length > 0 && newMessages[newMessages.length - 1].isUser && isRecognizingRef.current) {
                // Update existing temporary message
                newMessages[newMessages.length - 1] = {
                  text: e.result.text,
                  isUser: true
                };
              } else {
                // Add new temporary message
                newMessages.push({
                  text: e.result.text,
                  isUser: true
                });
              }
              return newMessages;
            });
            isRecognizingRef.current = true;
            setIsRecognizing(true);
          }
        };

        newRecognizer.recognized = async (_, e) => {
          if (e.result.reason === speechsdk.ResultReason.RecognizedSpeech && e.result.text) {
            console.log(`ERKANNT: ${e.result.text}`);
            isRecognizingRef.current = false;
            setIsRecognizing(false);

            // Remove temporary message before sending
            setMessages(prev => {
              const newMessages = [...prev];
              // Remove last message if it was a temporary recognizing message
              if (newMessages.length > 0 && newMessages[newMessages.length - 1].isUser) {
                newMessages.pop();
              }
              return newMessages;
            });

            await handleSend(e.result.text);
          } else {
            // If recognition failed or was cancelled, remove temporary message
            isRecognizingRef.current = false;
            setIsRecognizing(false);
            setMessages(prev => {
              const newMessages = [...prev];
              if (newMessages.length > 0 && newMessages[newMessages.length - 1].isUser) {
                newMessages.pop();
              }
              return newMessages;
            });
          }
        };

        newRecognizer.canceled = (_, e) => {
          console.log(`ABGEBROCHEN: ${e.errorDetails}`);
          setIsListening(false);
          isRecognizingRef.current = false;
          setIsRecognizing(false);

          // Remove temporary message if present
          setMessages(prev => {
            const newMessages = [...prev];
            if (newMessages.length > 0 && newMessages[newMessages.length - 1].isUser) {
              newMessages.pop();
            }
            return newMessages;
          });
        };

        recognizer.current = newRecognizer;
        startListening();
      } catch (error) {
        console.error('Fehler bei der Recognizer-Initialisierung:', error);
        recognizer.current = null;
        setIsListening(false);
      }
    } catch (error) {
      console.error('Allgemeiner Fehler bei der Recognizer-Initialisierung:', error);
      recognizer.current = null;
      setIsListening(false);
    }
  };

  const stopListening = () => {
    if (recognizer.current) {
      try {
        recognizer.current.stopContinuousRecognitionAsync(
          () => {
            setIsListening(false);
            console.log("Spracherkennung gestoppt");

            // Remove temporary message if present
            if (isRecognizingRef.current) {
              isRecognizingRef.current = false;
              setIsRecognizing(false);
              setMessages(prev => {
                const newMessages = [...prev];
                if (newMessages.length > 0 && newMessages[newMessages.length - 1].isUser) {
                  newMessages.pop();
                }
                return newMessages;
              });
            }
          },
          (error) => {
            console.error("Fehler beim Stoppen der Spracherkennung:", error);
            setIsListening(false);

            // Remove temporary message if present
            if (isRecognizingRef.current) {
              isRecognizingRef.current = false;
              setIsRecognizing(false);
              setMessages(prev => {
                const newMessages = [...prev];
                if (newMessages.length > 0 && newMessages[newMessages.length - 1].isUser) {
                  newMessages.pop();
                }
                return newMessages;
              });
            }
          }
        );
      } catch (error) {
        console.error("Fehler beim Stoppen der Spracherkennung:", error);
        setIsListening(false);
      }
    }
  };

  const startListening = () => {
    if (!SPEECH_KEY || !SPEECH_REGION) {
      console.error('Speech credentials nicht konfiguriert');
      return;
    }

    if (recognizer.current) {
      try {
        recognizer.current.startContinuousRecognitionAsync(
          () => {
            setIsListening(true);
            console.log("Spracherkennung gestartet");
          },
          (error) => {
            console.error("Fehler beim Starten der Spracherkennung:", error);
            setIsListening(false);
          }
        );
      } catch (error) {
        console.error("Fehler beim Starten der Spracherkennung:", error);
        setIsListening(false);
      }
    }
  };

  // Cleanup Effect
  useEffect(() => {
    return () => {
      // Cleanup beim Unmounten der Komponente
      if (recognizer.current) {
        try {
          recognizer.current.stopContinuousRecognitionAsync(
            () => {
              try {
                recognizer.current?.close();
              } catch (err) {
                console.warn('Fehler beim Schließen des Recognizers:', err);
              }
              recognizer.current = null;
            },
            (err) => {
              console.warn('Fehler beim Stoppen der Erkennung:', err);
              recognizer.current = null;
            }
          );
        } catch (error) {
          console.error("Fehler beim Cleanup des Recognizers:", error);
        }
      }
    };
  }, []);

  const handleSettingsChange = useCallback((setting: keyof ModelSettings, value: string | number) => {
    setModelSettings(prev => ({
      ...prev,
      [setting]: value
    }));
  }, []);

  const handleSystemPromptChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    handleSettingsChange('systemPrompt', e.target.value);
  }, [handleSettingsChange]);

  const handleMaxTokensChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    handleSettingsChange('maxTokens', parseInt(e.target.value));
  }, [handleSettingsChange]);

  const handleTemperatureChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    handleSettingsChange('temperature', parseFloat(e.target.value));
  }, [handleSettingsChange]);


  const dialectChangeQueue = useRef<Array<{ target: string, current: string }>>([]);
  const isProcessingDialectChange = useRef(false);

  // Effect to handle dialect changes
  useEffect(() => {
    const processDialectChange = async () => {
      if (dialectChangeQueue.current.length === 0 || isProcessingDialectChange.current) return;

      isProcessingDialectChange.current = true;
      const { target: newDialect, current: prevDialect } = dialectChangeQueue.current[0];

      try {
        // Stop any ongoing speech
        stopSpeech();

        // Clean up existing recognizer
        if (recognizer.current) {
          await new Promise<void>((resolve) => {
            recognizer.current?.stopContinuousRecognitionAsync(() => {
              recognizer.current?.close();
              recognizer.current = null;
              resolve();
            });
          });
        }

        // Update the dialect state
        setSelectedDialect(newDialect);

        // Services handle their own state, so no explicit re-init needed for dialect change alone
        // except keeping track of it for next request.

        // Initialize new recognizer with updated settings
        await initializeRecognizer();

      } catch (error) {
        console.error('Error during dialect change:', error);
        // Revert to previous dialect if change failed
        setSelectedDialect(prevDialect);
      } finally {
        // Remove processed dialect from queue
        dialectChangeQueue.current.shift();
        isProcessingDialectChange.current = false;

        // Process next in queue if available
        if (dialectChangeQueue.current.length > 0) {
          processDialectChange();
        }
      }
    };

    processDialectChange();
  }, [dialectChangeQueue.current.length]);

  const handleDialectChange = useCallback((event: any) => {
    const newDialect = event.target.value;
    if (newDialect !== selectedDialect) {
      // Add to queue with current and target dialects
      dialectChangeQueue.current.push({
        target: newDialect,
        current: selectedDialect
      });

      // Update UI immediately while processing in background
      setSelectedDialect(newDialect);

      // Trigger effect if not already processing
      if (!isProcessingDialectChange.current) {
        setSelectedDialect(prev => prev); // Force re-render to trigger effect
      }
    }
  }, [selectedDialect]);

  // Effect to initialize services
  useEffect(() => {
    const init = async () => {
      await translationService.current.initialize().catch(e => console.error("Translation init failed", e));
      await ttsProviders.current.gradio.initialize().catch(e => console.error("Gradio init failed", e));
      await ttsProviders.current.slang.initialize().catch(e => console.error("Slang init failed", e));
    };
    init();
  }, []);

  const processNextSentence = async () => {
    if (sentencesToProcess.current.length === 0) return;

    const nextSentence = sentencesToProcess.current[0];

    if (!isSpeechEnabled) {
      sentencesToProcess.current.shift();
      if (sentencesToProcess.current.length > 0) processNextSentence();
      return;
    }

    try {
      debugLog('Processing sentence:', nextSentence.text, 'sequence:', nextSentence.sequence);

      let textToSpeak = cleanTextForSpeech(nextSentence.text);
      const currentProviderName = ttsProviderNameRef.current;
      const currentDialect = selectedDialectRef.current;

      // 1. Translation Step (Optional - only for Gradio)
      if (currentProviderName === 'gradio') {
        try {
          let swissGermanText = await translationService.current.translate(textToSpeak, currentDialect);
          // Handle case where translation returns an array
          if (Array.isArray(swissGermanText)) {
            swissGermanText = swissGermanText[0] || textToSpeak;
          }
          debugLog('Swiss German:', swissGermanText);
          textToSpeak = swissGermanText;
        } catch (error) {
          console.error("Translation failed, falling back to original text", error);
        }
      }

      // 2. TTS Step
      const currentProvider = ttsProviders.current[currentProviderName];

      // Determine voice/dialect ID based on provider
      let voiceId = currentDialect;
      if (currentProviderName === 'slang') {
        voiceId = SLANG_VOICE_MAPPING[currentDialect] || 'gsw-CHE-gr'; // Default fallback
      }

      const audioUrl = await currentProvider.synthesize({
        text: textToSpeak,
        voiceOrLang: voiceId,
      });

      // In die Queue für die Wiedergabe einfügen
      audioQueue.current.push({
        text: textToSpeak,
        blobUrl: audioUrl,
        sequence: nextSentence.sequence
      });

      // Wenn nichts spielt, Wiedergabe starten
      if (!isPlayingAudioRef.current) {
        isPlayingAudioRef.current = true;
        playNextInQueue();
      }

    } catch (error) {
      console.error("Error processing sentence:", error);
    } finally {
      // Verarbeiteten Satz entfernen und nächsten starten
      sentencesToProcess.current.shift();
      if (sentencesToProcess.current.length > 0) {
        processNextSentence();
      }
    }
  };

  const generateAndQueueTTS = async (sentence: string) => {
    const sequence = nextSequenceNumberRef.current++;

    // Füge den Satz zur Verarbeitungswarteschlange hinzu
    sentencesToProcess.current.push({
      text: sentence,
      sequence
    });

    // Wenn dies der erste Satz ist, starte die Verarbeitung
    if (sentencesToProcess.current.length === 1) {
      processNextSentence();
    }
  };

  const extractSentences = (text: string): { sentences: string[]; remainder: string } => {
    // Ersetze Punkte in Abkürzungen mit einem Platzhalter
    const placeholder = '___DOT___';
    const protectedText = text.replace(/\b([Ss]t|[Dd]r|[Pp]rof|[Mm]r|[Mm]rs|[Mm]s|etc|z\.B|d\.h|u\.a|bzw)\./g, (match) =>
      match.replace('.', placeholder)
    );

    // Sätze an Satzzeichen trennen
    const sentenceRegex = /[^.!?]*[.!?]/g;
    const matches = protectedText.match(sentenceRegex) || [];

    // Satzenden wiederherstellen
    const sentences = matches.map(s =>
      s.replace(new RegExp(placeholder, 'g'), '.')  // Ersetze Platzhalter zurück mit Punkt
        .trim()
    );

    // Finde den Rest des Textes
    const remainder = protectedText
      .slice(matches.join('').length)
      .replace(new RegExp(placeholder, 'g'), '.')
      .trim();

    return { sentences, remainder };
  };

  useEffect(() => {
    audioPlayerRef.current = new Audio();
    audioPlayerRef.current.crossOrigin = "anonymous";
    audioPlayerRef.current.onended = () => {
      playNextInQueue();
    };
    audioPlayerRef.current.onerror = (e) => {
      console.error('Audio playback error:', e);
      playNextInQueue();
    };

    return () => {
      if (audioPlayerRef.current) {
        audioPlayerRef.current.onended = null;
        audioPlayerRef.current.onerror = null;
      }
    }
  }, []);

  return (
    <Container maxWidth="lg" sx={{ height: '100vh', py: 2 }}>
      <Box sx={{ display: 'flex', gap: 2, height: '100%' }}>
        {/* Linke Spalte - Einstellungen */}
        <Paper elevation={3} sx={{ width: 350, p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Typography variant="h6">
            Einstellungen
          </Typography>

          <FormControl fullWidth>
            <InputLabel id="provider-select-label">Provider</InputLabel>
            <Select
              labelId="provider-select-label"
              value={selectedProvider}
              label="Provider"
              onChange={handleProviderChange}
              disabled={isLoading}
              size="small"
            >
              {AVAILABLE_PROVIDERS.map((provider) => (
                <MenuItem key={provider.id} value={provider.id}>
                  {provider.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl fullWidth>
            <InputLabel id="model-select-label">Modell</InputLabel>
            <Select
              labelId="model-select-label"
              value={selectedModel}
              label="Modell"
              onChange={handleModelChange}
              disabled={isLoading}
              size="small"
            >
              {AVAILABLE_PROVIDERS
                .find(p => p.id === selectedProvider)
                ?.models.map((model) => (
                  <MenuItem key={model.id} value={model.id}>
                    {model.name}
                  </MenuItem>
                ))}
            </Select>
          </FormControl>

          <FormControl fullWidth>
            <InputLabel id="dialect-select-label">Dialekt</InputLabel>
            <Select
              labelId="dialect-select-label"
              value={selectedDialect}
              label="Dialekt"
              onChange={handleDialectChange}
              disabled={isLoading}
              size="small"
            >
              {AVAILABLE_DIALECTS.map((dialect) => (
                <MenuItem key={dialect.id} value={dialect.id}>
                  {dialect.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            label="System Prompt"
            value={modelSettings.systemPrompt}
            onChange={handleSystemPromptChange}
            size="small"
            fullWidth
            multiline
            rows={8}
          />

          <TextField
            label="Max Tokens"
            type="number"
            value={modelSettings.maxTokens}
            onChange={handleMaxTokensChange}
            size="small"
            fullWidth
            InputProps={{
              inputProps: { min: 1, max: 2048 }
            }}
          />

          <TextField
            label="Temperature"
            type="number"
            value={modelSettings.temperature}
            onChange={handleTemperatureChange}
            size="small"
            fullWidth
            InputProps={{
              inputProps: {
                min: 0,
                max: 1,
                step: 0.1
              }
            }}
          />

          <FormControl fullWidth size="small">
            <InputLabel id="tts-provider-label">TTS Engine</InputLabel>
            <Select
              labelId="tts-provider-label"
              value={ttsProviderName}
              label="TTS Engine"
              onChange={(e) => setTtsProviderName(e.target.value as 'gradio' | 'slang')}
            >
              <MenuItem value="gradio">FHNW (Gradio)</MenuItem>
              <MenuItem value="slang">SlowSoft (Slang)</MenuItem>
            </Select>
          </FormControl>

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={isListening}
                  onChange={handleMicrophoneToggle}
                  icon={<Mic />}
                  checkedIcon={<MicOff />}
                />
              }
              label={isListening ? "Mikrofon an" : "Mikrofon aus"}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={isSpeechEnabled}
                  onChange={handleSpeechToggle}
                  icon={<VolumeOff />}
                  checkedIcon={<VolumeUp />}
                />
              }
              label={isSpeechEnabled ? "Audio an" : "Audio aus"}
            />
          </Box>
        </Paper>

        {/* Rechte Spalte - Chat */}
        <Paper elevation={3} sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="h4">
              AI Chat
            </Typography>
            <IconButton
              color="primary"
              onClick={handleNewChat}
              title="Neuer Chat starten"
              sx={{
                '&:hover': {
                  backgroundColor: 'primary.light',
                  color: 'white'
                }
              }}
            >
              <AddCircleOutline fontSize="large" />
            </IconButton>
          </Box>

          <Box sx={{ flexGrow: 1, overflow: 'auto', p: 2 }}>
            <List>
              {messages.map((message, index) => {
                const isTemporary = isRecognizing && index === messages.length - 1 && message.isUser;
                return (
                  <MessageItem
                    key={index}
                    message={message}
                    isTemporary={isTemporary}
                  />
                );
              })}
            </List>
            {isLoading && (
              <Box display="flex" justifyContent="center" my={2}>
                <CircularProgress />
              </Box>
            )}
            <div ref={messagesEndRef} />
          </Box>

          <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                fullWidth
                variant="outlined"
                placeholder="Nachricht eingeben..."
                value={input}
                onChange={handleInputChange}
                onKeyPress={handleKeyPress}
              />
              <IconButton
                color="primary"
                onClick={handleClick}
                disabled={!input.trim() || isLoading}
              >
                <SendIcon />
              </IconButton>
            </Box>
          </Box>
        </Paper>
      </Box >
    </Container >
  );
}

export default App;
