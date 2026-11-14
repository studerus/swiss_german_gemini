# Swiss German AI Chat

A React application for spoken conversations with Google Gemini, OpenAI or Groq. It streams model responses and Swiss German speech, with a choice of recognition providers, voices and dialects.

[![Demo Video](https://img.youtube.com/vi/C0IQrF4O-6Y/0.jpg)](https://www.youtube.com/watch?v=C0IQrF4O-6Y)

## Features

- Streaming text responses through Vercel AI SDK 7.
- Live microphone transcription with Azure Speech or Suisse Speech, including intermediate results while speaking.
- Suisse Speech Swift streaming output, plus FHNW/Gradio and SlowSoft/Slang TTS.
- Provider-specific dialect selection, including 20 Suisse Speech regional and Swiss High German options.
- Model-specific reasoning effort, initially set to the lowest supported level.
- A collapsible latency panel with per-answer measurements and averages.
- An editable system prompt that asks for naturally spoken prose without lists, numbering or Markdown.

## Defaults

| Setting | Default |
| --- | --- |
| LLM provider | Groq |
| Groq model | `openai/gpt-oss-120b` |
| OpenAI model when selected | `chat-latest` |
| Gemini model when selected | `gemini-3.5-flash-lite` |
| Speech recognition | Azure Speech |
| Speech output | Suisse Speech, Swift streaming |
| Voice / dialect | Andrin / Basel |
| Pause until speech end | 500 ms |
| Requested speaking speed | 1.0×; see the known limitation below |
| Speaking style | Empty, using the voice's default delivery |

Changing the LLM provider selects its default model. Changing a model or provider resets reasoning effort to that model's minimum. Model availability depends on the API key and account permissions; previews are labeled in the selector. The model lists were updated on November 14, 2026.

OpenAI uses Chat Completions and explicitly sends `max_completion_tokens`, including for `chat-latest`. Temperature is omitted for the listed OpenAI models, and its settings field is hidden for that provider.

## Setup

Requires Node.js 22 or newer and npm.

```bash
git clone https://github.com/studerus/swiss_german_gemini
cd swiss_german_gemini
npm ci
```

Copy `.env.example` to `.env` and configure at least one LLM provider. Select that provider in the app if it differs from the default Groq selection.

```env
# At least one LLM provider
VITE_GROQ_API_KEY=your_groq_api_key
VITE_GEMINI_API_KEY=your_gemini_api_key
VITE_OPENAI_API_KEY=your_openai_api_key

# Suisse Speech recognition and synthesis; server-side, without VITE_
SUISSE_SPEECH_API_KEY=your_suisse_speech_api_key

# Only needed for Azure speech recognition
VITE_AZURE_SPEECH_KEY=your_azure_speech_key
VITE_AZURE_SPEECH_REGION=your_azure_region
```

Get keys from [Groq](https://console.groq.com/keys), [Google AI Studio](https://aistudio.google.com/app/apikey), [OpenAI](https://platform.openai.com/api-keys), [Suisse Speech](https://console.suisse-speech.ch/) or an [Azure Speech resource](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/overview).

```bash
npm run dev
```

Vite opens the application at `http://localhost:5173`. Restart Vite after changing environment variables. Microphone access requires a secure context, such as localhost or HTTPS.

Text chat needs only an LLM key. Suisse Speech voice input and output use the same Suisse Speech key and do not require Azure. Azure credentials are only needed when Azure is selected under **Spracherkennung**.

## Usage

Choose the LLM provider and model, then the TTS engine, voice and dialect. Send a typed message or enable the microphone. Partial microphone results appear as a temporary message; only completed user turns are added to the model history. Intentional repetitions are preserved.

**Spracherkennung** selects Azure Speech or **Suisse Speech (Streaming)** independently of the TTS engine. Switching recognition providers stops the current microphone session; enable the microphone again to use the new provider.

**Pause bis Sprachende** is adjustable from 100 to 5,000 ms in 50 ms steps. It starts at 500 ms, and changes apply at the next microphone start. Azure receives this as its segmentation silence timeout; Suisse Speech uses it for local pause detection. Shorter pauses can split a speaker's unfinished sentence into separate turns.

**Denkstufe** appears only for models with configured reasoning support. The system prompt and output-token limit are editable. Audio output can be disabled independently of microphone input. New replies, a new chat, and changes to the TTS engine, voice or dialect cancel pending output.

## Speech output

### Suisse Speech streaming

Suisse Speech is the default TTS provider. One WebSocket is opened per answer in parallel with the LLM request. Text chunks are forwarded immediately, and incoming binary PCM16 audio is scheduled through Web Audio with a 25 ms lead. The service handles sentence boundaries and dialect rendering; the client does not wait for a complete answer or audio file. The final text fragment is flushed when LLM generation finishes.

The selector offers twelve voices and twenty dialect/variety options. Andrin and Basel are initially selected. Regional options without published quality measurements are labeled. When switching to FHNW or Slang, shared dialects are preserved and otherwise fall back to Basel. Changing the output dialect does not restart speech recognition.

**Sprechtempo** requests a speed from 0.5× to 2.0× in 0.05 steps. **Sprechstil** accepts a free-text delivery instruction of up to 600 characters, for example `warm und deutlich`; an empty field leaves delivery at the voice's default. Values are sent as `speed` and `style` in `session.start` for the next audio answer. See the [TTS API reference](https://suisse-speech.ch/docs/reference/) and [streaming documentation](https://suisse-speech.ch/docs/text-to-speech/).

**Known limitation: speaking speed.** Live checks on November 14, 2026 with Swift, Andrin and Basel showed that the service acknowledged the requested speed but did not produce the expected tempo change. The same short text produced 2.89 seconds of PCM at 0.5× and 3.00 seconds at 2.0×. A separate server-side SSML check at 50% and 200% produced 2.63 and 2.60 seconds. These small differences do not demonstrate working speed control in this configuration, despite the documented support. The setting is transmitted correctly, but its audible effect is currently unreliable. No local playback-speed adjustment or audio-processing workaround is applied. The SSML checks were diagnostic only; normal streaming still sends plain text.

### Other TTS engines

- **FHNW / Gradio:** translates text into the selected dialect and processes complete sentences progressively.
- **SlowSoft / Slang:** processes the first sentence immediately, then collects the remaining response as a larger chunk for subsequent synthesis.

These engines retain their original eight dialect selections: Aargau, Bern, Basel, Graubünden, Luzern, St. Gallen, Valais and Zürich.

## Speech recognition

### Suisse Speech

The microphone streams PCM16 mono at 16 kHz over a persistent WebSocket. Intermediate transcript revisions are displayed while the user speaks. Final fragments can contain only part of a sentence, so they are accumulated rather than submitted to the LLM individually.

After the configured pause, the client sends `finalize`. The completed turn is submitted once `finalize.done` confirms that all its final fragments have arrived. The socket stays open for subsequent turns. Errors, disconnects and cancellation release microphone resources; late events from an older session are ignored.

Recognition uses `de-CH`. Swiss German and High German are transcribed in Standard German. Optional variety detection is left off to avoid its additional delay. See the [Suisse Speech STT protocol](https://suisse-speech.ch/docs/speech-to-text/).

### Azure Speech

Azure uses continuous recognition with `de-CH` and the configured segmentation silence timeout. A shared AudioWorklet captures the 16 kHz PCM supplied to recognition and anchors Azure's result offset/duration to the browser clock. If capture timing is unavailable, Azure can fall back to the standard microphone, leaving the speech-end latency measurement blank. See [Azure recognition results](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-speech-recognition-results).

## Latency measurements

Open **Latenzmessung** below the chat heading. The main value estimates the interval from the user's last speech sample to the first audible sample of the answer. Expand an individual answer for its breakdown. **Zurücksetzen** clears statistics without clearing the chat; measurements remain in memory for the current page session.

Each answer records its LLM model, reasoning effort, recognition provider, TTS provider, dialect and input type. The panel measures:

- Speech end to final transcription, including pause detection and recognition/network delay.
- Transcription to LLM dispatch, and LLM dispatch to first text.
- First text to TTS submission, TTS submission to first audio, and first audio to audible playback.
- Dialect translation for FHNW, where applicable.
- TTS connection setup and complete LLM generation, which run in parallel and must not be added to the sequential stages.

For Suisse Speech recognition, speech end is estimated from microphone energy. If only text activity reveals very quiet speech, recognition still finalizes the turn but its speech-end timing stays unavailable. Azure uses its recognizer timestamps mapped to the capture clock.

For Suisse Speech output, the client detects the first audible PCM sample using 5 ms RMS windows at -50 dBFS. Its output time is mapped through `getOutputTimestamp()` or estimated from scheduling and reported device latency. Leading silence remains part of the wait until audible playback. FHNW and Slang use the browser's `playing` event and do not analyze leading silence inside encoded files.

Typed input has a send-to-audio measurement without a speech-end timestamp. Missing timestamps, failures, silent output and cancellation before playback do not contribute to the primary average. Each metric has its own sample count; averages cover all providers/models since reset. These are browser estimates, not external acoustic measurements, and no additional audio recording is retained.

## Reasoning effort

Only the selected model's configured levels are offered. Unsupported selections are normalized to its minimum before sending the request.

- **OpenAI:** GPT-6 Astra and GPT-6.1 Sol start at `low`; the other listed GPT-6/6.1 and GPT-5.6 models start at `none`. Chat Latest has no verified effort configuration here, so its selector is hidden and no effort parameter is sent.
- **Gemini:** Gemini 4, Gemini 3.8 Flash and Gemini 3.1 Pro Preview start at `low`. Gemini 3.6 Flash, 3.5 Flash-Lite, 3.1 Flash-Lite and 3 Flash Preview start at `minimal`.
- **Groq:** GPT-OSS starts at `low`; Qwen 3.8 starts at `none`. Qwen uses the hidden reasoning format; separate reasoning content is excluded from the spoken text stream.

Higher effort can increase latency and consume the configured output-token budget before visible text is complete. Refer to the [OpenAI](https://developers.openai.com/api/docs/guides/latest-model), [Gemini](https://aistudio.google.com/docs/thinking#thinking-levels) and [Groq](https://console.groq.com/docs/reasoning) documentation for provider details.

## Deployment and API keys

The Vite development and preview servers provide authenticated WebSocket proxies at:

- `/api/suisse-speech/tts/stream`
- `/api/suisse-speech/stt/stream`

They rewrite `/api/suisse-speech` to `/v1`, forward to `wss://api.suisse-speech.ch`, and add `X-API-Key` on the server. Keep `SUISSE_SPEECH_API_KEY` without a `VITE_` prefix. A static production host must provide equivalent backends for both paths; static files alone cannot supply them. Slang also uses its configured `/api/slang` proxy.

The other provider integrations use `VITE_` variables, which are available in the browser build. `.env` is ignored by Git; `.env.example` contains placeholders only.

```bash
npm run build
npm run preview
```

## Tests

| Command | Coverage |
| --- | --- |
| `npm run test:chat` | Committed history, intermediate drafts, microphone lifecycle and current TTS settings |
| `npm run test:reasoning` | Provider/model defaults, reasoning serialization through SDK adapters and text-only response streaming |
| `npm run test:latency` | Clock mapping, averaging, microphone resampling, audible playback and panel rendering |
| `npm run test:stt` | Suisse Speech live-stream protocol, turn aggregation, cancellation and authenticated proxies |
| `npm run test:tts` | Suisse Speech request settings, PCM playback, cancellation, errors and authenticated proxies |

Tests use offline mocks and temporary local servers, without paid API calls. Live recognition quality, expressive style and real-world latency require separate microphone/listening checks. The speed comparisons documented above were separate live diagnostic requests, not part of the automated suite.

## Technology

React 18, TypeScript, Material UI 5, Vite 5, Vercel AI SDK 7, Azure Speech SDK, Suisse Speech WebSockets, FHNW/Gradio and SlowSoft/Slang.

## License

MIT
