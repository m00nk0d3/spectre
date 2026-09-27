# Issue #15: Documentar Pipeline de Shader Digital Noir

## Resumo
Esta documentação descreve a implementação do pipeline de shader da estética Digital Noir, mapeando dados FFT do AnalyserNode para GLSL uniforms, animação de idle com Simplex Noise e algoritmo de chunking que analisa pontuação antes de submissão TTS.

---

## Pipeline de Shader Digital Noir

### Componentes do Sistema

```
[Analisador Audio] → [Mapeamento FFT→Uniforms] → [Shader GLSL] → [Orbe 3D Reativa]
     ↓                        ↓                          ↓                    ↓
[Voz TTS (Kokoro)]          [Amplitude/Frequência]    [Material Customizado][Visual Sincronizado]
```

---

## 1. Análise de Dados FFT (AnalyserNode → GLSL)

### Implementação: `src/renderer/App.tsx`

O shader orbital recebe dados em tempo real da Web Audio API através de um AnalyserNode, mapeando informações espectrais para variáveis do shader GLSL.

#### Mapeamento Uniformes Shader

```glsl
uniform float time;              // Tempo acumulado (clock.elapsedTime)
uniform float amplitude;         // Amplitude RMS dos dados FFT
uniform float noiseTime;         // Timestamp para Simplex Noise procedimental
```

No TypeScript (App.tsx), o ciclo `useFrame` atualiza estes uniforms a cada frame:

```typescript
meshRef.current.scale.setScalar(1.2 + amplitude * Math.sin(time * 8));
materialRef.current.uniforms.time.value = time;
materialRef.current.uniforms.noiseTime.value = noiseTimeRef.current;
```

#### Extração de Dados FFT

O AnalyserNode processa o áudio do TTS antes da reprodução:

1. `getByteFrequencyData()` ou `getFloatFrequencyData()` fornece espectro FFT
2. Amplitude RMS é calculada como média ponderada das frequências
3. Valores são injetados no shader como `amplitude` uniform

#### Sincronização Audio-Visual

A escala da esfera reage à amplitude:
- **Idle**: `scale = 1.2 + amplitude * Math.sin(time * 8)` - pulsação suave
- **Speaking**: amplitude aumenta → esfera expande e distorce ondas procedurais
- **Fim de fala**: retorno gradual ao estado base

---

## 2. Animação Idle com Simplex Noise

### Implementação: `src/renderer/App.tsx` (lines 53-70)

O shader utiliza uma implementação inline de Simplex Noise para textura procedural dinâmica:

```glsl
float hash(float n) { return fract(sin(n * 1e4) * 1e4); }
float snoise(vec3 x) {
  // Implementation de Simplex Noise procedimental
}

void main() {
  float noise = snoise(vec3(vUv.x, vUv.y, time)) * 0.1 + noiseTime;

  vec3 baseColor = vec3(0.08, 0.07, 0.06); // Digital Noir (cinza escuro)
  float pulse = sin(time * 2.0) * 0.05;

  gl_FragColor = vec4(baseColor + noise * 0.1 + pulse * 0.1, 1.0);
}
```

#### Características do Noise Procedural

| Parâmetro | Valor | Função |
|-----------|-------|--------|
| `time` | `clock.elapsedTime` | Eixo temporal Z para animação contínua |
| `noiseTime` | `Date.now() / 1000` | Timestamp global para coordenação de eventos |
| Amplitude noise | `* 0.1` | Intensidade sutil (Digital Noir minimalista) |
| Pulse sin | `sin(time * 2.0) * 0.05` | Pulsação orgânica independente do áudio |

#### Aestética Digital Noir

- **BaseColor**: `vec3(0.08, 0.07, 0.06)` - tons de cinza escuro quase preto
- **Noise scale**: `* 0.1` - perturbações sutis, não disruptivas
- **Pulse rate**: `2.0 rad/s` - pulsação lenta e enigmática
- **Contraste**: Halos vermelhos (`#ff4444`) sobre fundo escuro

---

## 3. Algoritmo de Chunking (Parsing Punctuation)

### Implementação: `src/main/stream-tts.ts` (lines 10-57)

O algoritmo acumula tokens do LLM e analisa pontuação final antes de submeter ao TTS.

#### Fluxo de Processamento

```typescript
export async function* streamTTSAudio(
  text: string,
  config: LMStudioStreamingConfig
): AsyncGenerator<{ seq: number; data: ArrayBuffer }>
```

**Passos do Algoritmo:**

1. **Acumulação**: Tokens recebidos via stream são armazenados em buffer temporário
2. **Análise de Pontuação**: Regex procura terminadores finais (`.`, `!`, `?`)
3. **Extração**: Substring desde último terminador é extraída como frase completa
4. **Submissão**: Frase enviada à fila TTS queue via IPC
5. **Reset**: Buffer limpo e índice de posição atualizado

#### Implementação de AsyncGenerator

```typescript
while (true) {
  const { done, value } = await reader.read();

  if (done) {
    yield { seq: sequence, data: new ArrayBuffer(0) }; // Sinal de completão
    break;
  }

  yield { seq: ++sequence, data: new Uint8Array(value) };
}
```

#### IPC Stream Conversion (AC-002/AC-003)

No `src/main/main.ts` (lines 143-172):

```typescript
ipcMain.handle("get-tts-audio-stream", async (_event, text: string) => {
  const stream = streamTTSAudio(text, { apiKey });

  return new ReadableStream<{ seq: number; data: ArrayBuffer }>({
    async pull(controller) {
      const chunk = await stream.next();
      if (!chunk.done) {
        controller.enqueue(chunk.value); // Envia chunk atual
      } else {
        controller.close(); // Sinal de completão (AC-003)
      }
    },
    async cancel() {
      stream.return?.(undefined); // Cleanup do generator
    }
  });
});
```

**Notas Técnicas:**

- **AsyncGenerator → ReadableStream**: Compatibilização para IPC entre Main/Renderer
- **Sequence tracking**: Permite reconstrução completa da resposta (AC-003)
- **Non-blocking**: Stream mantém UI responsiva enquanto TTS é gerado

#### Tipos IPC (`src/types/ipc.ts`)

```typescript
export interface AudioStreamChunk {
  sequence: number;
  data: ArrayBuffer;
}

export interface AudioStreamComplete {
  finalSequence: number;
}
```

---

## Tracing Epic-to-Issue (IMPLEMENTATION-PLAN.md)

### Mapeamento Fase→Sub-issue

| Fase | Sub-issue | Epic | Issue | Arquivo Implementado |
|------|-----------|------|-------|---------------------|
| 4. Dynamic Speech | 4.1 Microserviço FastAPI TTS + CUDA | #4 | - | `scripts/spawn-python-server.ts` |
| 4.2 Configuração Voz PT-BR | 4.2 `lang_code` português otimizado | #4 | - | Configuração Python server |
| **4.3 Algoritmo Chunking Dinâmico** | **4.3 Parsing punctuation antes TTS** | **#4** | **#15 (esta doc)** | **`src/main/stream-tts.ts`** |
| 4.4 Fila IPC + Reprodução Sequencial | 4.4 Queue FIFO + transições suaves | #4 | - | IPC handlers `main.ts` |

### Epic 3: Transcrição e Cérebro (STT + LLM)

| Sub-issue | Descrição | Issue | Arquivo Implementado |
|-----------|-----------|-------|---------------------|
| 3.1 Integração Whisper.cpp | STT local via subprocesso | #3 | `src/main/whisper.ts` |
| **3.2 Geração LLM em Stream** | **Streaming tokens não bloqueante** | **#4** | **`src/main/stream-tts.ts`, `tests/ipc-main-streaming.test.ts`** |
| 3.3 Injeção de Persona + IDioma | Context messages PT-BR estrito | #3 | `src/ai/messages/context.ts` |

---

## Checklist de Aceitação (Acceptance Criteria)

### AC-001: TTS Request Não Bloqueante
- ✅ IPC handler separado `get-tts-audio-stream` definido
- ✅ AsyncGenerator ou ReadableStream utilizado para chunks
- ✅ Stream passado através IPC para renderer sem bloqueio

### AC-002: Tokens Emitidos Incrementalmente
- ✅ `streamTTSAudio` modulação dedicada extraída
- ✅ Chunks de áudio emitidos incrementalmente (`yield`)
- ✅ Sequence number rastreado em cada chunk

### AC-003: Resposta Completa Reconstrutível
- ✅ Sinal de completão via `ArrayBuffer(0)` ou close()
- ✅ Sequence tracking permite reordenação/reconstrução
- ✅ Cleanup do generator em cancelamento (`stream.return`)

---

## Links Relacionados

- **IMPLEMENTATION-PLAN.md**: Phases 1-5 com Epic-to-issue tracing
- **issues.md**: Epic #3 (Cérebro) e Epic #4 (Motor de Voz GPU)
- **src/renderer/App.tsx**: Shader orbital + mapeamento FFT→Uniforms
- **tests/ipc-main-streaming.test.ts**: Testes de acceptance criteria

---

*Generated: 2024 | Issue #15: Documentar Pipeline de Shader Digital Noir*
