import { useState, useRef, useEffect, useCallback, memo, useMemo } from 'react';
import { Alert, Box, Container, TextField, IconButton, Paper, Typography, List, ListItem, ListItemText, CircularProgress, Select, MenuItem, FormControl, FormHelperText, InputLabel, Slider, Switch, FormControlLabel } from '@mui/material';
import { Send as SendIcon, VolumeUp, VolumeOff, Mic, MicOff, AddCircleOutline } from '@mui/icons-material';
import { streamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createGroq } from '@ai-sdk/groq';
import * as speechsdk from 'microsoft-cognitiveservices-speech-sdk';
import { LatencyPanel } from './components/LatencyPanel';
import { LatencyRecord, LatencyTracker, VoiceInputTiming } from './services/latency';
import { MicrophoneCapture } from './services/audio/MicrophoneCapture';
import { SuisseSpeechSTTProvider } from './services/stt/SuisseSpeechSTTProvider';
import { getDefaultReasoningLevel, getReasoningLevels, getReasoningProviderOptions, REASONING_LABELS, ReasoningLevel, resolveReasoningLevel } from './services/reasoning';



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

const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

// Text chat models checked against the official catalogs on 2026-11-14.
const AVAILABLE_PROVIDERS: ProviderConfig[] = [
  {
    id: 'google',
    name: 'Google Gemini',
    models: [
      // https://aistudio.google.com/docs/models
      { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite (Standard)' },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
      { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
      { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite' },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)' },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (Preview)' },
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    models: [
      // https://developers.openai.com/api/docs/models
      { id: 'chat-latest', name: 'Chat Latest (Standard)' },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
      { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
      { id: 'gpt-6-sol', name: 'GPT-6 Sol' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    ]
  },
  {
    id: 'groq',
    name: 'Groq',
    models: [
      // Public chat models: https://console.groq.com/docs/models
      // Llama 3.3 and Llama 3.1 are now restricted to enterprise accounts.
      { id: DEFAULT_GROQ_MODEL, name: 'GPT-OSS 120B (recommended)' },
      { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B' },
      { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B (Preview)' },
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
import { SuisseSpeechTTSProvider, SUISSE_SPEECH_VOICES, SUISSE_SPEECH_DIALECT_OPTIONS, resolveSuisseSpeechDialect } from './services/tts/SuisseSpeechTTSProvider';
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
  latencyId: number;
}

type TTSProviderName = 'gradio' | 'slang' | 'suisse';

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
  const [latencyRecords, setLatencyRecords] = useState<LatencyRecord[]>([]);
  const [latency] = useState(() => new LatencyTracker(setLatencyRecords));
  const resetLatency = useCallback(() => latency.reset(), [latency]);
  const [messages, setMessages] = useState<Array<{ text: string; isUser: boolean }>>([]);
  const messagesRef = useRef<Array<{ text: string; isUser: boolean }>>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>('groq');
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_GROQ_MODEL);
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(() => getDefaultReasoningLevel('groq', DEFAULT_GROQ_MODEL)!);
  const reasoningLevels = getReasoningLevels(selectedProvider, selectedModel);
  const selectedReasoningLevel = resolveReasoningLevel(selectedProvider, selectedModel, reasoningLevel);
  const [isSpeechEnabled, setIsSpeechEnabled] = useState(true);
  const isSpeechEnabledRef = useRef(true);
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
  const [sttProvider, setSttProvider] = useState<'azure' | 'suisse'>('azure');
  const sttProviderRef = useRef<'azure' | 'suisse'>('azure');
  const [sttError, setSttError] = useState<string | null>(null);
  const suisseRecognizerRef = useRef<SuisseSpeechSTTProvider | null>(null);
  const [speechSilenceTimeoutMs, setSpeechSilenceTimeoutMs] = useState(500);
  const speechSilenceTimeoutMsRef = useRef(500);
  const recognizer = useRef<speechsdk.SpeechRecognizer | null>(null);
  const microphoneCaptureRef = useRef<MicrophoneCapture | null>(null);
  const microphoneInputRef = useRef<speechsdk.PushAudioInputStream | null>(null);
  const microphoneGenerationRef = useRef(0);
  const sendMessageRef = useRef<(text: string, timing?: VoiceInputTiming) => Promise<void>>();
  const [recognitionText, setRecognitionText] = useState('');
  const isRecognizingRef = useRef(false);
  const [modelSettings, setModelSettings] = useState<ModelSettings>({
    systemPrompt: `Du bist ein freundlicher Roboter namens Hans. Du funktionierst so, dass du durch speech to text in Realzeit transkribiertes Audio als Input bekommst.
Es kann sein, dass Inputs falsch transkribiert werden. Falls du also zusammenhangslos wirkende Inputs bekommst, frage nach, ob du es richtig verstanden hast.
Deine Antworten werden direkt vorgelesen. Schreibe in natürlichem, zusammenhängendem Fliesstext mit kurzen, vollständigen Sätzen, die sich flüssig aussprechen lassen. Verwende keine Aufzählungen, Bulletpoints, Nummerierungen, Überschriften oder Markdown-Markierungen wie Sternchen, Fettdruck oder Codeblöcke. Verbinde mehrere Inhalte durch natürliche sprachliche Übergänge.`,
    maxTokens: 500,
    temperature: 0.7
  });
  const [ttsProviderName, setTtsProviderName] = useState<TTSProviderName>('suisse');
  const ttsProviderNameRef = useRef<TTSProviderName>('suisse');
  const [suisseSpeech] = useState(() => new SuisseSpeechTTSProvider());
  const [suisseVoice, setSuisseVoice] = useState('andrin');
  const suisseVoiceRef = useRef('andrin');
  const [suisseSpeed, setSuisseSpeed] = useState(1);
  const suisseSpeedRef = useRef(1);
  const [suisseStyle, setSuisseStyle] = useState('');
  const suisseStyleRef = useRef('');
  const [ttsError, setTtsError] = useState<string | null>(null);
  const ttsGenerationRef = useRef(0);

  // Services
  const translationService = useRef<TranslationService>(new FHNWTranslationService());
  const ttsProviders = useRef<{ gradio: TTSProvider, slang: TTSProvider }>({
    gradio: new GradioTTSProvider(),
    slang: new SlangTTSProvider()
  });
  const [selectedDialect, setSelectedDialect] = useState<string>('basel');
  const selectedDialectRef = useRef<string>('basel');
  const availableDialects = ttsProviderName === 'suisse' ? SUISSE_SPEECH_DIALECT_OPTIONS : AVAILABLE_DIALECTS;
  const suisseDialect = ttsProviderName === 'suisse'
    ? SUISSE_SPEECH_DIALECT_OPTIONS.find(dialect => dialect.id === selectedDialect)
    : undefined;
  const audioQueue = useRef<AudioQueueItem[]>([]);
  const isPlayingAudioRef = useRef<boolean>(false);
  const nextSequenceNumberRef = useRef<number>(0);
  const sentencesToProcess = useRef<Array<{
    text: string;
    sequence: number;
    latencyId: number;
  }>>([]);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const firstSentenceTimeRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, recognitionText]);

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
        return openai.chat(selectedModel);
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
          audio.onplaying = () => latency.mark(nextItem.latencyId, 'playback', performance.now(), 'media-event');
          audio.onended = () => {
            if (actualPlayableUrl?.startsWith("blob:")) {
              // Optionally revoke, but maybe keep for replay or handle in separate cleanup
              // For now, let's revoke to avoid memory leaks
              URL.revokeObjectURL(actualPlayableUrl);
            }
            resolve();
          };
          audio.onerror = (e) => {
            latency.fail(nextItem.latencyId);
            console.error('Audio playback error:', e);
            resolve();
          };
          audio.play().catch(playErr => {
            latency.fail(nextItem.latencyId);
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
    latency.cancelActive();
    ttsGenerationRef.current++;
    suisseSpeech.stop();
    // Stoppe aktuelle Audiowiedergabe
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
    }

    // Leere die Queues
    for (const item of audioQueue.current) {
      if (item.blobUrl.startsWith('blob:')) URL.revokeObjectURL(item.blobUrl);
    }
    audioQueue.current = [];
    sentencesToProcess.current = [];

    // Reset des Playback-Status
    isPlayingAudioRef.current = false;
  };


  const handleProviderChange = useCallback((event: any) => {
    stopSpeech();
    const newProvider = event.target.value as ProviderId;
    setSelectedProvider(newProvider);
    // Set default model for the new provider
    const defaultModel = AVAILABLE_PROVIDERS.find(p => p.id === newProvider)?.models[0].id || '';
    setSelectedModel(defaultModel);
    setReasoningLevel(getDefaultReasoningLevel(newProvider, defaultModel) ?? 'low');
    setMessages([]); // Clear chat history on provider change
  }, []);

  const handleModelChange = useCallback((event: any) => {
    const model = event.target.value;
    setSelectedModel(model);
    setReasoningLevel(getDefaultReasoningLevel(selectedProvider, model) ?? 'low');
  }, [selectedProvider]);

  const handleSend = async (messageText?: string, voiceTiming?: VoiceInputTiming) => {
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

    // Capture committed history before queuing UI updates for this turn.
    const conversationMessages: Array<{ role: 'user' | 'assistant', content: string }> = [
      ...messagesRef.current.map(msg => ({
        role: msg.isUser ? 'user' as const : 'assistant' as const,
        content: msg.text
      })),
      { role: 'user', content: textToSend }
    ];

    stopSpeech();
    const responseGeneration = ttsGenerationRef.current;
    const useSuisseSpeech = ttsProviderNameRef.current === 'suisse';
    const latencyId = latency.begin({
      text: textToSend, source: voiceTiming ? 'voice' : 'text', model: selectedModel,
      provider: selectedProvider, tts: ttsProviderNameRef.current, dialect: selectedDialectRef.current,
      reasoningLevel: selectedReasoningLevel ? REASONING_LABELS[selectedReasoningLevel] : undefined,
      audioEnabled: isSpeechEnabledRef.current
    }, performance.now(), voiceTiming);
    setTtsError(null);
    setInput('');

    // Add user message to UI
    setMessages(prevMessages => [...prevMessages, { text: textToSend, isUser: true }]);
    setIsLoading(true);

    try {
      // Add empty assistant message
      setMessages(prevMessages => [...prevMessages, { text: '', isUser: false }]);

      // Reset all relevant variables
      firstSentenceTimeRef.current = null;
      startTimeRef.current = performance.now();
      nextSequenceNumberRef.current = 0; // Reset sequence counter
      let firstSentenceReceivedTime: number | null = null;
      let fullResponse = '';
      let currentBuffer = '';

      if (useSuisseSpeech && isSpeechEnabledRef.current) {
        latency.mark(latencyId, 'ttsConnect');
        isPlayingAudioRef.current = true;
        suisseSpeech.start({
          dialect: selectedDialectRef.current,
          voice: suisseVoiceRef.current,
          speed: suisseSpeedRef.current,
          style: suisseStyleRef.current,
          onTiming: (step, at) => latency.mark(latencyId, step, at),
          onPlaybackStart: (at, method) => {
            latency.mark(latencyId, 'playback', at, method);
            if (firstSentenceTimeRef.current === null) {
              firstSentenceTimeRef.current = at;
              debugLog(`Suisse Speech first audio in ${Math.round(firstSentenceTimeRef.current - startTimeRef.current)}ms`);
            }
          },
          onComplete: hadAudibleSamples => {
            isPlayingAudioRef.current = false;
            if (!hadAudibleSamples) latency.silent(latencyId);
          },
          onError: error => {
            latency.fail(latencyId);
            isPlayingAudioRef.current = false;
            setTtsError(error.message);
          }
        });
      }

      // Use AI SDK streamText
      latency.mark(latencyId, 'request');
      const reasoningOptions = getReasoningProviderOptions(selectedProvider, selectedModel, selectedReasoningLevel);
      const result = streamText({
        model: getModelInstance(),
        instructions: modelSettings.systemPrompt,
        messages: conversationMessages,
        // Explicit OpenAI budget also covers aliases the SDK does not recognize.
        maxOutputTokens: selectedProvider === 'openai' ? undefined : modelSettings.maxTokens,
        temperature: selectedProvider === 'openai' ? undefined : modelSettings.temperature,
        providerOptions: selectedProvider === 'openai'
          ? { openai: { ...reasoningOptions?.openai, maxCompletionTokens: modelSettings.maxTokens } }
          : reasoningOptions,
        onError: ({ error }) => {
          latency.fail(latencyId);
          if (useSuisseSpeech && responseGeneration === ttsGenerationRef.current) {
            suisseSpeech.stop();
            isPlayingAudioRef.current = false;
          }
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
        if (chunk.length) latency.mark(latencyId, 'firstToken');
        fullResponse += chunk;

        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1] = {
            text: fullResponse,
            isUser: false
          };
          return newMessages;
        });

        if (responseGeneration !== ttsGenerationRef.current) continue;
        if (useSuisseSpeech) {
          // Forward tokens immediately; Suisse Speech performs its own segmentation.
          suisseSpeech.appendText(chunk);
          continue;
        }

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
            sentences.forEach(s => generateAndQueueTTS(s, latencyId));
          }
          currentBuffer = remainder;
        } else if (!firstSentenceSent) {
          // Slang: Only split the FIRST sentence to start playback quickly
          const { sentences, remainder } = extractSentences(currentBuffer);
          if (sentences.length > 0) {
            firstSentenceContent = sentences[0];
            generateAndQueueTTS(firstSentenceContent, latencyId);
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
      latency.endText(latencyId);
      if (!fullResponse && isSpeechEnabledRef.current) latency.silent(latencyId);
      const finalProvider = ttsProviderNameRef.current;
      if (responseGeneration !== ttsGenerationRef.current) {
        // Playback was cancelled while the text response was still streaming.
      } else if (useSuisseSpeech) {
        suisseSpeech.finish();
      } else if (finalProvider === 'gradio') {
        if (currentBuffer.trim()) {
          generateAndQueueTTS(currentBuffer.trim(), latencyId);
          currentBuffer = '';
        }
      } else {
        // For Slang
        if (!firstSentenceSent) {
          // Response was too short to have a sentence boundary, or just one sentence
          if (fullResponse.trim()) {
            generateAndQueueTTS(fullResponse.trim(), latencyId);
          }
        } else {
          // Send the rest of the response as one single chunk for better quality
          const rest = fullResponse.slice(fullResponse.indexOf(firstSentenceContent) + firstSentenceContent.length).trim();
          if (rest) {
            generateAndQueueTTS(rest, latencyId);
          }
        }
      }
    } catch (error) {
      latency.fail(latencyId);
      if (useSuisseSpeech && responseGeneration === ttsGenerationRef.current) {
        suisseSpeech.stop();
        isPlayingAudioRef.current = false;
      }
      console.error('Error:', error);
      setMessages(prev => [...prev, { text: 'Es tut mir leid, es ist ein Fehler aufgetreten.', isUser: false }]);
    } finally {
      setIsLoading(false);
    }
  };

  // Continuous microphone callbacks must use the current model/settings.
  useEffect(() => { sendMessageRef.current = handleSend; }, [handleSend]);

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
    stopSpeech();
    setRecognitionText('');
    isRecognizingRef.current = false;
    setMessages([]);
    messagesRef.current = [];
  }, []);

  const handleSpeechSilenceTimeoutChange = useCallback((_event: Event, value: number | number[]) => {
    if (typeof value !== 'number') return;
    speechSilenceTimeoutMsRef.current = value;
    setSpeechSilenceTimeoutMs(value);
  }, []);

  const handleMicrophoneToggle = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      if (ttsProviderNameRef.current === 'suisse') {
        void suisseSpeech.unlockAudio().catch(() => setTtsError('Die Audiowiedergabe konnte nicht gestartet werden.'));
      }
      initializeRecognizer();
    } else {
      stopListening();
    }
  }, []);

  const handleSpeechToggle = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    isSpeechEnabledRef.current = e.target.checked;
    setIsSpeechEnabled(e.target.checked);
    if (!e.target.checked) stopSpeech();
    else if (ttsProviderNameRef.current === 'suisse') {
      void suisseSpeech.unlockAudio().catch(() => setTtsError('Die Audiowiedergabe konnte nicht gestartet werden.'));
    }
  }, []);

  const releaseMicrophone = () => {
    microphoneCaptureRef.current?.stop();
    microphoneCaptureRef.current = null;
    microphoneInputRef.current?.close();
    microphoneInputRef.current = null;
    suisseRecognizerRef.current?.stop();
    suisseRecognizerRef.current = null;
  };

  const initializeRecognizer = async () => {
    const generation = ++microphoneGenerationRef.current;
    releaseMicrophone();
    setSttError(null);
    setIsListening(true);
    setRecognitionText('');
    isRecognizingRef.current = false;
    try {
      // Stelle sicher, dass der vorherige Recognizer sauber beendet wird
      if (recognizer.current) {
        const previousRecognizer = recognizer.current;
        recognizer.current = null;
        await new Promise<void>((resolve) => {
          previousRecognizer.stopContinuousRecognitionAsync(
            () => {
              try {
                previousRecognizer.close();
              } catch (err) {
                console.warn('Fehler beim Schließen des Recognizers:', err);
              }
              resolve();
            },
            (err) => {
              console.warn('Fehler beim Stoppen der Erkennung:', err);
              previousRecognizer.close();
              resolve();
            }
          );
        });
      }

      if (generation !== microphoneGenerationRef.current) return;
      if (sttProviderRef.current === 'suisse') {
        const stream = new SuisseSpeechSTTProvider();
        suisseRecognizerRef.current = stream;
        await stream.start({
          silenceTimeoutMs: speechSilenceTimeoutMsRef.current,
          onPartial: text => {
            if (generation !== microphoneGenerationRef.current) return;
            if (text && !isRecognizingRef.current && isPlayingAudioRef.current) stopSpeech();
            setRecognitionText(text);
            isRecognizingRef.current = Boolean(text);
          },
          onFinal: (text, timing) => {
            if (generation !== microphoneGenerationRef.current) return;
            isRecognizingRef.current = false;
            setRecognitionText('');
            void sendMessageRef.current?.(text, timing);
          },
          onError: error => {
            if (generation !== microphoneGenerationRef.current) return;
            microphoneGenerationRef.current++;
            releaseMicrophone();
            setIsListening(false);
            isRecognizingRef.current = false;
            setRecognitionText('');
            setSttError(error.message);
          }
        });
        if (generation !== microphoneGenerationRef.current) { stream.stop(); return; }
        const capture = new MicrophoneCapture((buffer, at) => stream.appendAudio(buffer, at));
        microphoneCaptureRef.current = capture;
        await capture.start();
        if (generation !== microphoneGenerationRef.current) { capture.stop(); stream.stop(); return; }
        return;
      }
      if (!SPEECH_KEY || !SPEECH_REGION) throw new Error('Azure-Speech-Schlüssel und Region sind nicht konfiguriert.');

      try {
        const speechConfig = speechsdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);
        speechConfig.speechRecognitionLanguage = "de-CH";
        // The microphone toggle is stable; read the latest setting at session start.
        speechConfig.setProperty(speechsdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, String(speechSilenceTimeoutMsRef.current));

        let audioConfig: speechsdk.AudioConfig;
        let capture: MicrophoneCapture | undefined;
        const pushStream = speechsdk.AudioInputStream.createPushStream(speechsdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));
        try {
          capture = new MicrophoneCapture(buffer => pushStream.write(buffer));
          microphoneCaptureRef.current = capture;
          microphoneInputRef.current = pushStream;
          await capture.start();
          if (generation !== microphoneGenerationRef.current) { capture.stop(); pushStream.close(); return; }
          audioConfig = speechsdk.AudioConfig.fromStreamInput(pushStream);
        } catch (error) {
          if (generation !== microphoneGenerationRef.current) { capture?.stop(); pushStream.close(); return; }
          releaseMicrophone();
          if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'NotFoundError')) throw error;
          console.warn('Audiozeitmessung nicht verfügbar; Standardmikrofon wird verwendet.', error);
          capture = undefined;
          audioConfig = speechsdk.AudioConfig.fromDefaultMicrophoneInput();
        }
        const newRecognizer = new speechsdk.SpeechRecognizer(speechConfig, audioConfig);

        // Events konfigurieren
        newRecognizer.recognizing = (_, e) => {
          if (generation !== microphoneGenerationRef.current) return;
          if (e.result.text) {
            console.log(`ERKENNE: ${e.result.text}`);

            // Stop speech only if audio is playing and this is the first recognition
            if (!isRecognizingRef.current && isPlayingAudioRef.current) {
              stopSpeech();
            }

            // Interim recognition is display-only, never part of model history.
            setRecognitionText(e.result.text);
            isRecognizingRef.current = true;
          }
        };

        newRecognizer.recognized = async (_, e) => {
          if (generation !== microphoneGenerationRef.current) return;
          if (e.result.reason === speechsdk.ResultReason.RecognizedSpeech && e.result.text) {
            console.log(`ERKANNT: ${e.result.text}`);
            isRecognizingRef.current = false;
            setRecognitionText('');

            const transcript = performance.now();
            const speechEnd = capture?.clock.speechEnd(e.result.offset, e.result.duration, transcript);
            await sendMessageRef.current?.(e.result.text, { speechEnd, transcript, provider: 'azure', speechEndMethod: 'recognizer' });
          } else {
            // Clear only the draft; committed chat messages remain intact.
            isRecognizingRef.current = false;
            setRecognitionText('');
          }
        };

        newRecognizer.canceled = (_, e) => {
          if (generation !== microphoneGenerationRef.current) return;
          releaseMicrophone();
          console.log(`ABGEBROCHEN: ${e.errorDetails}`);
          setIsListening(false);
          setSttError(e.errorDetails || 'Die Azure-Spracherkennung wurde beendet.');
          isRecognizingRef.current = false;
          setRecognitionText('');
        };

        recognizer.current = newRecognizer;
        startListening();
      } catch (error) {
        if (generation !== microphoneGenerationRef.current) return;
        releaseMicrophone();
        console.error('Fehler bei der Recognizer-Initialisierung:', error);
        recognizer.current = null;
        setIsListening(false);
        setSttError(error instanceof Error ? error.message : 'Die Spracherkennung konnte nicht gestartet werden.');
      }
    } catch (error) {
      if (generation !== microphoneGenerationRef.current) return;
      releaseMicrophone();
      console.error('Allgemeiner Fehler bei der Recognizer-Initialisierung:', error);
      recognizer.current = null;
      setIsListening(false);
      setSttError(error instanceof Error ? error.message : 'Die Spracherkennung konnte nicht gestartet werden.');
    }
  };

  const stopListening = () => {
    microphoneGenerationRef.current++;
    releaseMicrophone();
    setIsListening(false);
    isRecognizingRef.current = false;
    setRecognitionText('');
    const previousRecognizer = recognizer.current;
    recognizer.current = null;
    const close = () => previousRecognizer?.close();
    try { previousRecognizer?.stopContinuousRecognitionAsync(close, close); }
    catch (error) { close(); console.error('Fehler beim Stoppen der Spracherkennung:', error); }
  };

  const startListening = () => {
    const generation = microphoneGenerationRef.current;
    if (!SPEECH_KEY || !SPEECH_REGION) {
      console.error('Speech credentials nicht konfiguriert');
      return;
    }

    if (recognizer.current) {
      try {
        recognizer.current.startContinuousRecognitionAsync(
          () => {
            if (generation !== microphoneGenerationRef.current) return;
            setIsListening(true);
            console.log("Spracherkennung gestartet");
          },
          (error) => {
            if (generation !== microphoneGenerationRef.current) return;
            releaseMicrophone();
            console.error("Fehler beim Starten der Spracherkennung:", error);
            setIsListening(false);
            setSttError(String(error));
          }
        );
      } catch (error) {
        releaseMicrophone();
        console.error("Fehler beim Starten der Spracherkennung:", error);
        setIsListening(false);
      }
    }
  };

  // Cleanup Effect
  useEffect(() => {
    return () => {
      microphoneGenerationRef.current++;
      releaseMicrophone();
      // Cleanup beim Unmounten der Komponente
      if (recognizer.current) {
        const previousRecognizer = recognizer.current;
        recognizer.current = null;
        try {
          previousRecognizer.stopContinuousRecognitionAsync(
            () => {
              try {
                previousRecognizer.close();
              } catch (err) {
                console.warn('Fehler beim Schließen des Recognizers:', err);
              }
            },
            (err) => {
              console.warn('Fehler beim Stoppen der Erkennung:', err);
              previousRecognizer.close();
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


  const handleDialectChange = useCallback((event: any) => {
    const newDialect = event.target.value;
    if (newDialect !== selectedDialectRef.current) {
      stopSpeech();
      selectedDialectRef.current = newDialect;
      setSelectedDialect(newDialect);
    }
  }, []);

  // Effect to initialize services
  useEffect(() => {
    if (ttsProviderName === 'gradio') {
      void translationService.current.initialize().catch(e => console.error("Translation init failed", e));
      void ttsProviders.current.gradio.initialize().catch(e => console.error("Gradio init failed", e));
    } else if (ttsProviderName === 'slang') {
      void ttsProviders.current.slang.initialize().catch(e => console.error("Slang init failed", e));
    }
  }, [ttsProviderName]);

  const processNextSentence = async () => {
    if (sentencesToProcess.current.length === 0) return;

    const nextSentence = sentencesToProcess.current[0];
    const generation = ttsGenerationRef.current;

    if (!isSpeechEnabled) {
      sentencesToProcess.current.shift();
      if (sentencesToProcess.current.length > 0) processNextSentence();
      return;
    }

    try {
      debugLog('Processing sentence:', nextSentence.text, 'sequence:', nextSentence.sequence);

      let textToSpeak = cleanTextForSpeech(nextSentence.text);
      const currentProviderName = ttsProviderNameRef.current;
      if (currentProviderName === 'suisse') return;
      const currentDialect = selectedDialectRef.current;

      // 1. Translation Step (Optional - only for Gradio)
      if (currentProviderName === 'gradio') {
        latency.mark(nextSentence.latencyId, 'translationStart');
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
        } finally {
          latency.mark(nextSentence.latencyId, 'translationEnd');
        }
      }

      // 2. TTS Step
      const currentProvider = ttsProviders.current[currentProviderName];

      // Determine voice/dialect ID based on provider
      let voiceId = currentDialect;
      if (currentProviderName === 'slang') {
        voiceId = SLANG_VOICE_MAPPING[currentDialect] || 'gsw-CHE-gr'; // Default fallback
      }

      latency.mark(nextSentence.latencyId, 'ttsText');
      const audioUrl = await currentProvider.synthesize({
        text: textToSpeak,
        voiceOrLang: voiceId,
      });
      latency.mark(nextSentence.latencyId, 'firstAudio');

      if (generation !== ttsGenerationRef.current) {
        if (audioUrl.startsWith('blob:')) URL.revokeObjectURL(audioUrl);
        return;
      }

      // In die Queue für die Wiedergabe einfügen
      audioQueue.current.push({
        text: textToSpeak,
        blobUrl: audioUrl,
        sequence: nextSentence.sequence,
        latencyId: nextSentence.latencyId
      });

      // Wenn nichts spielt, Wiedergabe starten
      if (!isPlayingAudioRef.current) {
        isPlayingAudioRef.current = true;
        playNextInQueue();
      }

    } catch (error) {
      latency.fail(nextSentence.latencyId);
      console.error("Error processing sentence:", error);
    } finally {
      // Verarbeiteten Satz entfernen und nächsten starten
      if (generation === ttsGenerationRef.current) {
        sentencesToProcess.current.shift();
        if (sentencesToProcess.current.length > 0) processNextSentence();
      }
    }
  };

  const generateAndQueueTTS = async (sentence: string, latencyId: number) => {
    const sequence = nextSequenceNumberRef.current++;

    // Füge den Satz zur Verarbeitungswarteschlange hinzu
    sentencesToProcess.current.push({
      text: sentence,
      sequence,
      latencyId
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
    return () => suisseSpeech.dispose();
  }, [suisseSpeech]);

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
        audioPlayerRef.current.onplaying = null;
        audioPlayerRef.current.onended = null;
        audioPlayerRef.current.onerror = null;
      }
    }
  }, []);

  return (
    <Container maxWidth="lg" sx={{ height: '100vh', py: 2 }}>
      <Box sx={{ display: 'flex', gap: 2, height: '100%' }}>
        {/* Linke Spalte - Einstellungen */}
        <Paper elevation={3} sx={{ width: 350, flexShrink: 0, overflowY: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
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

          {reasoningLevels.length ? (
            <FormControl fullWidth size="small">
              <InputLabel id="reasoning-level-label">Denkstufe</InputLabel>
              <Select
                labelId="reasoning-level-label"
                value={selectedReasoningLevel ?? ''}
                label="Denkstufe"
                disabled={isLoading}
                onChange={event => setReasoningLevel(event.target.value as ReasoningLevel)}
              >
                {reasoningLevels.map((level, index) => (
                  <MenuItem key={level} value={level}>
                    {REASONING_LABELS[level]}{index === 0 ? ' (Standard)' : ''}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : null}

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
              {availableDialects.map((dialect) => (
                <MenuItem key={dialect.id} value={dialect.id}>
                  {dialect.name}
                </MenuItem>
              ))}
            </Select>
            {suisseDialect?.id === 'hochdeutsch' ? (
              <FormHelperText>Standarddeutsch mit Schweizer Aussprache, ohne Dialektübersetzung.</FormHelperText>
            ) : suisseDialect && !suisseDialect.verified ? (
              <FormHelperText>Unterstützte regionale Variante ohne veröffentlichte Qualitätsmessung.</FormHelperText>
            ) : null}
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

          {selectedProvider !== 'openai' ? (
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
          ) : null}

          <FormControl fullWidth size="small">
            <InputLabel id="tts-provider-label">TTS Engine</InputLabel>
            <Select
              labelId="tts-provider-label"
              value={ttsProviderName}
              label="TTS Engine"
              disabled={isLoading}
              onChange={(e) => {
                stopSpeech();
                const provider = e.target.value as TTSProviderName;
                ttsProviderNameRef.current = provider;
                setTtsProviderName(provider);
                const suisseDialectId = resolveSuisseSpeechDialect(selectedDialectRef.current);
                const nextDialect = provider === 'suisse' ? suisseDialectId :
                  AVAILABLE_DIALECTS.find(dialect => resolveSuisseSpeechDialect(dialect.id) === suisseDialectId)?.id ?? 'Basel';
                selectedDialectRef.current = nextDialect;
                setSelectedDialect(nextDialect);
                setTtsError(null);
                if (provider === 'suisse') {
                  void suisseSpeech.unlockAudio().catch(() => setTtsError('Die Audiowiedergabe konnte nicht gestartet werden.'));
                }
              }}
            >
              <MenuItem value="suisse">Suisse Speech (Swift Streaming)</MenuItem>
              <MenuItem value="gradio">FHNW (Gradio)</MenuItem>
              <MenuItem value="slang">SlowSoft (Slang)</MenuItem>
            </Select>
          </FormControl>

          {ttsProviderName === 'suisse' ? (
            <>
              <FormControl fullWidth size="small">
                <InputLabel id="suisse-voice-label">Stimme</InputLabel>
                <Select
                  labelId="suisse-voice-label"
                  value={suisseVoice}
                  label="Stimme"
                  disabled={isLoading}
                  onChange={event => {
                    stopSpeech();
                    suisseVoiceRef.current = event.target.value;
                    setSuisseVoice(event.target.value);
                  }}
                >
                  {SUISSE_SPEECH_VOICES.map(voice => (
                    <MenuItem key={voice} value={voice}>{voice[0].toUpperCase() + voice.slice(1)}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Box>
                <Typography id="suisse-speed-label" variant="body2">
                  Sprechtempo: {suisseSpeed.toFixed(2)}×
                </Typography>
                <Slider
                  aria-labelledby="suisse-speed-label"
                  value={suisseSpeed}
                  min={0.5}
                  max={2}
                  step={0.05}
                  disabled={isLoading}
                  valueLabelDisplay="auto"
                  valueLabelFormat={value => `${value.toFixed(2)}×`}
                  getAriaValueText={value => `${value.toFixed(2)}-faches Sprechtempo`}
                  onChange={(_event, value) => {
                    if (typeof value !== 'number') return;
                    suisseSpeedRef.current = value;
                    setSuisseSpeed(value);
                  }}
                />
              </Box>
              <TextField
                label="Sprechstil"
                value={suisseStyle}
                placeholder="Zum Beispiel: warm, ruhig und deutlich"
                onChange={event => {
                  suisseStyleRef.current = event.target.value;
                  setSuisseStyle(event.target.value);
                }}
                inputProps={{ maxLength: 600 }}
                disabled={isLoading}
                size="small"
                fullWidth
                multiline
                minRows={2}
                maxRows={5}
              />
            </>
          ) : null}
          {ttsError ? <Alert severity="error" onClose={() => setTtsError(null)}>{ttsError}</Alert> : null}

          <FormControl fullWidth size="small">
            <InputLabel id="stt-provider-label">Spracherkennung</InputLabel>
            <Select
              labelId="stt-provider-label"
              label="Spracherkennung"
              value={sttProvider}
              onChange={event => {
                stopListening();
                const provider = event.target.value as 'azure' | 'suisse';
                sttProviderRef.current = provider;
                setSttProvider(provider);
                setSttError(null);
              }}
            >
              <MenuItem value="azure">Azure Speech</MenuItem>
              <MenuItem value="suisse">Suisse Speech (Streaming)</MenuItem>
            </Select>
          </FormControl>
          {sttError ? <Alert severity="error" onClose={() => setSttError(null)}>{sttError}</Alert> : null}

          <Box>
            <Typography id="speech-silence-timeout-label" variant="body2">
              Pause bis Sprachende: {speechSilenceTimeoutMs} ms
            </Typography>
            <Slider
              aria-labelledby="speech-silence-timeout-label"
              value={speechSilenceTimeoutMs}
              onChange={handleSpeechSilenceTimeoutChange}
              min={100}
              max={5000}
              step={50}
              valueLabelDisplay="auto"
            />
            <Typography variant="caption" color="text.secondary">
              Gilt beim nächsten Mikrofonstart.
            </Typography>
          </Box>

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
        <Paper elevation={3} sx={{ flexGrow: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
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

          <LatencyPanel records={latencyRecords} onReset={resetLatency} />
          <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', p: 2 }}>
            <List>
              {messages.map((message, index) => {
                return (
                  <MessageItem
                    key={index}
                    message={message}
                    isTemporary={false}
                  />
                );
              })}
              {recognitionText ? (
                <MessageItem message={{ text: recognitionText, isUser: true }} isTemporary={true} />
              ) : null}
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
