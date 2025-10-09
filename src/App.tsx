import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { Box, Container, TextField, IconButton, Paper, Typography, List, ListItem, ListItemText, CircularProgress, Select, MenuItem, FormControl, InputLabel, Switch, FormControlLabel } from '@mui/material';
import { Send as SendIcon, VolumeUp, VolumeOff, Mic, MicOff, AddCircleOutline } from '@mui/icons-material';
import { GoogleGenAI } from '@google/genai';
import * as speechsdk from 'microsoft-cognitiveservices-speech-sdk';
import { Client } from "@gradio/client";

// Modulweite Variable zur Vermeidung der mehrfachen Initialisierung
let ttsClientPromise: Promise<Client> | null = null;

interface ModelSettings {
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
}

const AVAILABLE_MODELS = [
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (empfohlen)' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (fortgeschritten)' },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite (schnell)' },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (legacy)' }
] as const;

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

type ModelId = typeof AVAILABLE_MODELS[number]['id'];

interface TTSClient {
  client: Promise<Client> | null;
  isReady: boolean;
}

interface AudioQueueItem {
  text: string;
  audioData: AudioResponse['data'][0];
  sequence: number;
}

interface TranslationResponse {
  data: string;
  type: string;
  time: Date;
  endpoint: string;
  fn_index: number;
}

interface AudioResponse {
  data: [{
    url: string;
    path: string;
    size: number | null;
    orig_name: string;
    mime_type: string | null;
  }];
  type: string;
  time: Date;
  endpoint: string;
  fn_index: number;
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
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ModelId>('gemini-2.5-flash-lite');
  const [isSpeechEnabled, setIsSpeechEnabled] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const aiRef = useRef<GoogleGenAI | null>(null);
  const chatRef = useRef<any>(null);
  const API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
  const SPEECH_KEY = import.meta.env.VITE_AZURE_SPEECH_KEY || '';
  const SPEECH_REGION = import.meta.env.VITE_AZURE_SPEECH_REGION || '';
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
  const [_ttsClient, setTTSClient] = useState<TTSClient>({
    client: null,
    isReady: false
  });
  const [selectedDialect, setSelectedDialect] = useState<string>("Basel");
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

  const createAudioBlobUrl = async (audioUrl: string): Promise<string> => {
    try {
      const response = await fetch(audioUrl, {
        mode: 'cors',
        credentials: 'include'
      });
      const blob = await response.blob();
      return URL.createObjectURL(blob);
    } catch (error) {
      console.error('Error creating blob URL:', error);
      throw error;
    }
  };

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
        const audioData = nextItem.audioData;
        let actualPlayableUrl: string | null = null;

        if (audioData?.url) {
          try {
            const blobUrl = await createAudioBlobUrl(audioData.url);
            actualPlayableUrl = blobUrl;
          } catch (blobError) {
            debugLog('Falling back to direct URL');
            actualPlayableUrl = audioData.url;
          }
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
        debugLog('Items arrived while playing, re-run queue');
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
    
    debugLog('Speech output stopped');
  };

  const initializeChat = () => {
    if (API_KEY) {
      // Initialize AI client if not already done
      if (!aiRef.current) {
        aiRef.current = new GoogleGenAI({ apiKey: API_KEY });
      }
      
      // Kombiniere System Prompt mit der bisherigen Konversation
      const history = [
        { role: 'model', parts: [{ text: modelSettings.systemPrompt }] },
        ...messages.map(msg => ({
          role: msg.isUser ? 'user' : 'model',
          parts: [{ text: msg.text }]
        }))
      ];
      
      chatRef.current = aiRef.current.chats.create({
        model: selectedModel,
        config: {
          maxOutputTokens: modelSettings.maxTokens,
          temperature: modelSettings.temperature,
        },
        history: history,
      });
    }
  };

  const handleModelChange = useCallback((event: any) => {
    setSelectedModel(event.target.value as ModelId);
    setMessages([]); // Lösche Chat-Historie bei Modellwechsel
    initializeChat(); // Initialisiere Chat neu mit leerem Verlauf
  }, []);

  const handleSend = async (messageText?: string) => {
    const textToSend = messageText || input.trim();
    
    if (!textToSend || !API_KEY) return;

    // Initialisiere Chat falls noch nicht geschehen
    if (!chatRef.current) {
      initializeChat();
    }

    if (!chatRef.current) return;

    // Only stop speech if audio is actually playing
    if (isPlayingAudioRef.current) {
      stopSpeech();
    }
    setInput('');
    
    // Fügen Sie die Benutzernachricht zum UI hinzu
    setMessages(prevMessages => [...prevMessages, { text: textToSend, isUser: true }]);
    setIsLoading(true);

    try {
      // Fügen Sie eine leere Modell-Antwort hinzu
      setMessages(prevMessages => [...prevMessages, { text: '', isUser: false }]);
      
      // Initialize AI client if not already done
      if (!aiRef.current) {
        aiRef.current = new GoogleGenAI({ apiKey: API_KEY });
      }
      
      // Kombiniere System Prompt mit der bisherigen Konversation
      const history = [
        { role: 'model', parts: [{ text: modelSettings.systemPrompt }] },
        ...messages.map(msg => ({
          role: msg.isUser ? 'user' : 'model',
          parts: [{ text: msg.text }]
        }))
      ];
      
      chatRef.current = aiRef.current.chats.create({
        model: selectedModel,
        config: {
          maxOutputTokens: modelSettings.maxTokens,
          temperature: modelSettings.temperature,
        },
        history: history,
      });

      // Setze alle relevanten Variablen zurück
      firstSentenceTimeRef.current = null;
      startTimeRef.current = performance.now();
      nextSequenceNumberRef.current = 0; // Setze Sequenzzähler zurück
      let firstSentenceReceivedTime: number | null = null;
      let fullResponse = '';
      let currentBuffer = '';

      // Verwenden Sie den aktualisierten Chat mit der neuen API
      const result = await chatRef.current.sendMessageStream({ message: textToSend });

      for await (const chunk of result) {
        const chunkText = chunk.text || '';
        fullResponse += chunkText;
        
        setMessages(prev => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1] = {
            text: fullResponse,
            isUser: false
          };
          return newMessages;
        });

        currentBuffer += chunkText;
        
        const { sentences, remainder } = extractSentences(currentBuffer);
        if (sentences.length > 0) {
          // Erster Satz empfangen
          if (firstSentenceReceivedTime === null) {
            firstSentenceReceivedTime = performance.now();
            console.log(`[TTS Debug] First sentence received in ${Math.round(firstSentenceReceivedTime - startTimeRef.current)}ms`);
          }
          sentences.forEach(s => generateAndQueueTTS(s));
        }
        currentBuffer = remainder;
      }

      if (currentBuffer.trim()) {
        generateAndQueueTTS(currentBuffer.trim());
        currentBuffer = '';
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
    initializeChat();
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

  const reinitializeTTSClient = async () => {
    try {
      ttsClientPromise = Client.connect("https://stt4sg.fhnw.ch/tts/");
      const client = await ttsClientPromise;
      setTTSClient({
        client: Promise.resolve(client),
        isReady: true
      });
    } catch (error) {
      console.error('Failed to reinitialize TTS client:', error);
      ttsClientPromise = null;
      setTTSClient({
        client: null,
        isReady: false
      });
    }
  };

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
        
        // Reinitialize TTS client with new dialect
        await reinitializeTTSClient();
        
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

  const initializeTTSClient = async () => {
    if (ttsClientPromise) {
      try {
        const client = await ttsClientPromise;
        setTTSClient({
          client: Promise.resolve(client),
          isReady: true
        });
      } catch (error) {
        // Error already logged
      }
      return;
    }
    
    ttsClientPromise = Client.connect("https://stt4sg.fhnw.ch/tts/");
    
    try {
      const client = await ttsClientPromise;
      setTTSClient({
        client: Promise.resolve(client),
        isReady: true
      });
    } catch (error) {
      console.error('Fehler bei der Initialisierung des TTS-Clients:', error);
      ttsClientPromise = null;
      setTTSClient({
        client: null,
        isReady: false
      });
    }
  };

  useEffect(() => {
    const init = async () => {
      // If client promise already exists (e.g., from previous mount in StrictMode),
      // wait for it and set state
      if (ttsClientPromise) {
        try {
          const client = await ttsClientPromise;
          setTTSClient({
            client: Promise.resolve(client),
            isReady: true
          });
        } catch (error) {
          console.error('Error restoring TTS client state:', error);
        }
      } else {
        // Initialize new client
        await initializeTTSClient();
      }
    };
    
    init();
  }, []);

  const processNextSentence = async () => {
    if (sentencesToProcess.current.length === 0) return;

    const nextSentence = sentencesToProcess.current[0];
    
    if (!isSpeechEnabled || !ttsClientPromise) {
      return;
    }

    try {
      const client = await ttsClientPromise;
      debugLog('Processing sentence:', nextSentence.text, 'sequence:', nextSentence.sequence);

      // Übersetzen
      const translationResult = (await client.predict("/translate_interface", {
        text_de: cleanTextForSpeech(nextSentence.text),
        dialect: selectedDialect,
      })) as unknown as TranslationResponse;

      const swissGermanText = translationResult.data;
      debugLog('Swiss German:', swissGermanText);

      // Audio generieren
      const audioResponse = (await client.predict("/speech_interface", {
        edited_text: swissGermanText,
        dialect: selectedDialect,
      })) as AudioResponse;

      if (!audioResponse?.data?.[0]) {
        throw new Error("No audio data from TTS");
      }

      // In die Queue für die Wiedergabe einfügen
      audioQueue.current.push({
        text: swissGermanText,
        audioData: audioResponse.data[0],
        sequence: nextSentence.sequence
      });

      // Wenn nichts spielt, Wiedergabe starten
      if (!isPlayingAudioRef.current) {
        debugLog('Starting playback as nothing is playing');
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
    debugLog('Queueing sentence for processing:', sentence, 'sequence:', sequence);
    
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
      debugLog('Audio playback ended');
      playNextInQueue();
    };
    audioPlayerRef.current.onerror = (e) => {
      console.error('Audio playback error:', e);
      debugLog('Audio error event:', e);
      playNextInQueue();
    };
    audioPlayerRef.current.onplay = () => debugLog('Audio started playing');
    audioPlayerRef.current.onloadeddata = () => debugLog('Audio data loaded');

    return () => {
      if (audioPlayerRef.current) {
        audioPlayerRef.current.onended = null;
        audioPlayerRef.current.onerror = null;
        audioPlayerRef.current.onplay = null;
        audioPlayerRef.current.onloadeddata = null;
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
            <InputLabel id="model-select-label">Modell</InputLabel>
            <Select
              labelId="model-select-label"
              value={selectedModel}
              label="Modell"
              onChange={handleModelChange}
              disabled={isLoading}
              size="small"
            >
              {AVAILABLE_MODELS.map((model) => (
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
              Gemini Chat
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
      </Box>
    </Container>
  );
}

export default App;
