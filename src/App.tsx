import { useState, useRef, useEffect } from 'react';
import { Box, Container, TextField, IconButton, Paper, Typography, List, ListItem, ListItemText, CircularProgress, Select, MenuItem, FormControl, InputLabel, Switch, FormControlLabel } from '@mui/material';
import { Send as SendIcon, VolumeUp, VolumeOff, Mic, MicOff } from '@mui/icons-material';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as speechsdk from 'microsoft-cognitiveservices-speech-sdk';
import { Client } from "@gradio/client";

interface ModelSettings {
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
}

const AVAILABLE_MODELS = [
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
  { id: 'gemini-pro', name: 'Gemini Pro' }
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
  client: Promise<Client>;
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

function App() {
  const [messages, setMessages] = useState<Array<{ text: string; isUser: boolean }>>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ModelId>('gemini-1.5-flash');
  const [isSpeechEnabled, setIsSpeechEnabled] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<any>(null);
  const API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
  const SPEECH_KEY = import.meta.env.VITE_AZURE_SPEECH_KEY || '';
  const SPEECH_REGION = import.meta.env.VITE_AZURE_SPEECH_REGION || '';
  const [isListening, setIsListening] = useState(false);
  const recognizer = useRef<speechsdk.SpeechRecognizer | null>(null);
  const [modelSettings, setModelSettings] = useState<ModelSettings>({
    systemPrompt: `Du bist ein freundlicher Roboter aus Basel namens Hans. Antworte auf Hochdeutsch. Du funktionierst so, dass du durch speech to text in Realzeit transkribiertes Audio als Input bekommst.
Es kann sein, dass Inputs falsch transkribiert werden. Falls du also zusammenhangslos wirkende Inputs bekommst, frage nach, ob du es richtig verstanden hast.`,
    maxTokens: 500,
    temperature: 0.7
  });
  const [ttsClient, setTTSClient] = useState<TTSClient>({
    client: Client.connect("https://stt4sg.fhnw.ch/tts/"),
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
            debugLog('Setting blob URL:', blobUrl);
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
      const genAI = new GoogleGenerativeAI(API_KEY);
      const model = genAI.getGenerativeModel({ model: selectedModel });
      
      // Kombiniere System Prompt mit der bisherigen Konversation
      const history = [
        { role: 'model', parts: modelSettings.systemPrompt },
        ...messages.map(msg => ({
          role: msg.isUser ? 'user' : 'model',
          parts: msg.text
        }))
      ];
      
      chatRef.current = model.startChat({
        history: history,
        generationConfig: {
          maxOutputTokens: modelSettings.maxTokens,
          temperature: modelSettings.temperature,
        },
      });
    }
  };

  const handleModelChange = (event: any) => {
    setSelectedModel(event.target.value as ModelId);
    setMessages([]); // Lösche Chat-Historie bei Modellwechsel
    initializeChat(); // Initialisiere Chat neu mit leerem Verlauf
  };

  const handleSend = async (messageText?: string) => {
    const textToSend = messageText || input.trim();
    
    if (!textToSend || !API_KEY) return;

    // Initialisiere Chat falls noch nicht geschehen
    if (!chatRef.current) {
      initializeChat();
    }

    if (!chatRef.current) return;

    stopSpeech();
    setInput('');
    
    // Fügen Sie die Benutzernachricht zum UI hinzu
    setMessages(prevMessages => [...prevMessages, { text: textToSend, isUser: true }]);
    setIsLoading(true);

    try {
      // Fügen Sie eine leere Modell-Antwort hinzu
      setMessages(prevMessages => [...prevMessages, { text: '', isUser: false }]);
      
      // Erstelle einen neuen Chat mit der aktuellen History
      const genAI = new GoogleGenerativeAI(API_KEY);
      const model = genAI.getGenerativeModel({ model: selectedModel });
      
      // Kombiniere System Prompt mit der bisherigen Konversation
      const history = [
        { role: 'model', parts: modelSettings.systemPrompt },
        ...messages.map(msg => ({
          role: msg.isUser ? 'user' : 'model',
          parts: msg.text
        }))
      ];
      
      chatRef.current = model.startChat({
        history: history,
        generationConfig: {
          maxOutputTokens: modelSettings.maxTokens,
          temperature: modelSettings.temperature,
        },
      });

      // Setze alle relevanten Variablen zurück
      firstSentenceTimeRef.current = null;
      startTimeRef.current = performance.now();
      nextSequenceNumberRef.current = 0; // Setze Sequenzzähler zurück
      let firstSentenceReceivedTime: number | null = null;
      let fullResponse = '';
      let currentBuffer = '';

      // Verwenden Sie den aktualisierten Chat
      const result = await chatRef.current.sendMessageStream(textToSend);

      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
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

  // Erstelle einen separaten Click-Handler für den Button
  const handleClick = () => {
    handleSend();
  };

  const initializeRecognizer = async () => {
    // Clean up existing recognizer if it exists
    if (recognizer.current) {
      try {
        await new Promise<void>((resolve, reject) => {
          recognizer.current?.stopContinuousRecognitionAsync(
            () => {
              recognizer.current?.close();
              recognizer.current = null;
              resolve();
            },
            (err) => {
              console.error('Error stopping recognition:', err);
              reject(err);
            }
          );
        });
      } catch (error) {
        console.error('Error during recognizer cleanup:', error);
      }
    }

    if (SPEECH_KEY && SPEECH_REGION) {
      const speechConfig = speechsdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);
      speechConfig.speechRecognitionLanguage = "de-CH";
      
      const audioConfig = speechsdk.AudioConfig.fromDefaultMicrophoneInput();
      const newRecognizer = new speechsdk.SpeechRecognizer(speechConfig, audioConfig);

      // Events konfigurieren
      newRecognizer.recognizing = (_, e) => {
        console.log(`ERKENNE: ${e.result.text}`);
        stopSpeech();
      };

      newRecognizer.recognized = async (_, e) => {
        if (e.result.reason === speechsdk.ResultReason.RecognizedSpeech && e.result.text) {
          console.log(`ERKANNT: ${e.result.text}`);
          await handleSend(e.result.text);
        }
      };

      newRecognizer.canceled = (_, e) => {
        console.log(`ABGEBROCHEN: ${e.errorDetails}`);
        stopListening();
      };

      recognizer.current = newRecognizer;
      startListening();
    }
  };

  const stopListening = () => {
    if (recognizer.current) {
      recognizer.current.stopContinuousRecognitionAsync(() => {
        setIsListening(false);
        console.log("Spracherkennung gestoppt");
      });
    }
  };

  useEffect(() => {
    initializeRecognizer();
    return () => {
      stopListening();
    };
  }, [SPEECH_KEY, SPEECH_REGION]);

  const handleSettingsChange = (setting: keyof ModelSettings, value: string | number) => {
    setModelSettings(prev => ({
      ...prev,
      [setting]: value
    }));
  };

  const reinitializeTTSClient = async () => {
    try {
      debugLog('Reinitializing TTS client...');
      const client = await Client.connect("https://stt4sg.fhnw.ch/tts/");
      setTTSClient({
        client: Promise.resolve(client),
        isReady: true
      });
      debugLog('TTS client reinitialized successfully');
    } catch (error) {
      console.error('Failed to reinitialize TTS client:', error);
      setTTSClient(prev => ({
        ...prev,
        isReady: false
      }));
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

  const handleDialectChange = (event: any) => {
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
  };

  useEffect(() => {
    const initializeTTSClient = async () => {
      try {
        debugLog('Initializing TTS client...');
        const client = await Client.connect("https://stt4sg.fhnw.ch/tts/");
        setTTSClient({
          client: Promise.resolve(client),
          isReady: true
        });
        debugLog('TTS client initialized successfully');
      } catch (error) {
        console.error('Failed to initialize TTS client:', error);
        setTTSClient(prev => ({
          ...prev,
          isReady: false
        }));
      }
    };

    initializeTTSClient();
  }, []); // Leeres Dependency-Array, da wir nur einmal beim Mount initialisieren wollen

  const processNextSentence = async () => {
    if (sentencesToProcess.current.length === 0) return;

    const nextSentence = sentencesToProcess.current[0];
    try {
      if (!isSpeechEnabled || !ttsClient.isReady) return;

      const client = await ttsClient.client;
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

  const startListening = () => {
    if (!SPEECH_KEY || !SPEECH_REGION) {
      console.error('Speech credentials not configured');
      return;
    }

    stopSpeech(); // Stoppe Sprachausgabe wenn Nutzer spricht
    
    if (recognizer.current) {
      recognizer.current.startContinuousRecognitionAsync(
        () => {
          setIsListening(true);
          console.log("Spracherkennung gestartet");
        },
        (error) => {
          console.error("Error starting recognition:", error);
        }
      );
    }
  };

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
            onChange={(e) => handleSettingsChange('systemPrompt', e.target.value)}
            size="small"
            fullWidth
            multiline
            rows={8}
          />
          
          <TextField
            label="Max Tokens"
            type="number"
            value={modelSettings.maxTokens}
            onChange={(e) => handleSettingsChange('maxTokens', parseInt(e.target.value))}
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
            onChange={(e) => handleSettingsChange('temperature', parseFloat(e.target.value))}
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
                  onChange={(e) => e.target.checked ? initializeRecognizer() : stopListening()}
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
                  onChange={(e) => setIsSpeechEnabled(e.target.checked)}
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
          <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
            <Typography variant="h4">
              Gemini Chat
            </Typography>
          </Box>
          
          <Box sx={{ flexGrow: 1, overflow: 'auto', p: 2 }}>
            <List>
              {messages.map((message, index) => (
                <ListItem
                  key={index}
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
                    }}
                  >
                    <ListItemText primary={message.text} />
                  </Paper>
                </ListItem>
              ))}
            </List>
            {isLoading && (
              <Box display="flex" justifyContent="center" my={2}>
                <CircularProgress />
              </Box>
            )}
            <div ref={messagesEndRef} />
          </Box>

          <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
            <Paper 
              elevation={1} 
              sx={{ 
                p: 1, 
                mb: 2, 
                cursor: 'pointer', 
                '&:hover': { backgroundColor: 'primary.light', color: 'white' } 
              }}
              onClick={() => {
                setMessages([]);
                initializeChat();
              }}
            >
              <Typography variant="body1" align="center">
                Neuer Chat starten
              </Typography>
            </Paper>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                fullWidth
                variant="outlined"
                placeholder="Nachricht eingeben..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
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
