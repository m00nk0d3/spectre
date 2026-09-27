# Epics e Sub-issues: Projeto SPECTRE (Detailed Specification)

## Epic 1: Fundação e Orquestração Base (Electron + Hyprland)
**Objetivo:** Estabelecer o esqueleto da aplicação, garantindo que o SPECTRE vive no desktop de forma invisível (frameless/transparente) e gere o ciclo de vida dos processos adjacentes.

### Sub-issue 1.1: Inicializar template React + TypeScript no Electron
*   **Descrição:** Configurar o repositório base utilizando `electron-vite` para garantir um ambiente de desenvolvimento rápido com HMR (Hot Module Replacement) para o React.
*   **Requisitos:** Node.js, gestor de pacotes (npm/pnpm), dependências do Electron e React instaladas.
*   **Acceptance Criteria:**
    *   O comando de desenvolvimento lança a aplicação sem erros.
    *   A interface React renderiza com sucesso dentro do processo nativo do Electron.
    *   O build de produção gera um executável Linux compatível com o Omarchy.

### Sub-issue 1.2: Configurar BrowserWindow para modo transparente
*   **Descrição:** Manipular as APIs do Main Process do Electron e o CSS global do React para remover a janela tradicional do sistema operativo, deixando apenas o conteúdo da app flutuar no ecrã.
*   **Requisitos:** Acesso à API `BrowserWindow` do Electron.
*   **Acceptance Criteria:**
    *   A aplicação não apresenta bordas, barra de título ou botões de controlo nativos.
    *   O fundo da aplicação é 100% transparente (o wallpaper ou janelas por trás são visíveis).
    *   A aplicação mantém-se sempre no topo (`alwaysOnTop`).

### Sub-issue 1.3: Integração com o Window Manager (Hyprland)
*   **Descrição:** Definir regras específicas no sistema operativo do utilizador para forçar o comportamento visual pretendido, contornando o *tiling* padrão do Hyprland.
*   **Requisitos:** Ficheiro `hyprland.conf` do sistema e a classe X11/Wayland correta da aplicação Electron.
*   **Acceptance Criteria:**
    *   O SPECTRE é sempre lançado em modo flutuante (nunca em *tiling*).
    *   A janela ignora as bordas padrão do Hyprland e sombras globais.
    *   A janela é fixada (`pin`) em todos os *workspaces*, acompanhando a navegação do utilizador.

### Sub-issue 1.4: Orquestração do subprocesso Python
*   **Descrição:** O Node.js deve ser o ponto único de entrada do SPECTRE, responsabilizando-se por lançar e desligar o servidor Python de áudio, evitando processos órfãos na memória.
*   **Requisitos:** Módulo `child_process` do Node.js, ambiente virtual Python configurado com o servidor FastAPI.
*   **Acceptance Criteria:**
    *   No arranque da aplicação Electron, o servidor FastAPI arranca automaticamente em background.
    *   A aplicação Electron aguarda a confirmação (via *stdout*) de que o modelo Kokoro carregou na GPU antes de ativar o microfone.
    *   Ao fechar ou forçar o encerramento da app Electron, o processo Python é morto instantaneamente (PID *kill* limpo).

---

## Epic 2: Ouvido Atento (Captação VAD no Frontend)
**Objetivo:** Garantir que o SPECTRE ouve autonomamente sem necessidade de *push-to-talk*, recolhendo a voz de forma limpa e ignorando o silêncio.

### Sub-issue 2.1: Integrar VAD (Voice Activity Detection)
*   **Descrição:** Implementar deteção de voz no frontend em React utilizando processamento via WebAssembly local, monitorizando a entrada do microfone.
*   **Requisitos:** Biblioteca `@ricky0123/vad-web`, permissões de acesso ao microfone no Electron.
*   **Acceptance Criteria:**
    *   O VAD aciona um evento de "Início" apenas quando capta fala humana (ignorando ruído de fundo ou cliques de teclado mecânico).
    *   O VAD aciona um evento de "Fim" após um período de silêncio configurável (ex: 1.5s).

### Sub-issue 2.2: Conversão de áudio para formato WAV
*   **Descrição:** Pegar nos dados em bruto gerados pelo VAD no final da fala e transformá-los num ficheiro de áudio standard para STT.
*   **Requisitos:** Manipulação de estruturas `Float32Array` e cabeçalhos binários do formato WAV.
*   **Acceptance Criteria:**
    *   Os dados captados são encapsulados num buffer WAV a 16kHz, mono.
    *   O áudio resultante, se guardado no disco, é perfeitamente reproduzível e compreensível num leitor normal.

### Sub-issue 2.3: IPC do buffer de áudio
*   **Descrição:** Passar os dados pesados de áudio do contexto do browser (React) para o sistema operativo (Node.js) de forma segura.
*   **Requisitos:** Utilização do `contextBridge` e scripts de `preload` do Electron.
*   **Acceptance Criteria:**
    *   O buffer binário viaja para o Main Process sem perdas e sem causar paragens na renderização a 60fps da interface 3D.
    *   A tipagem do TypeScript reflete corretamente a assinatura da função de envio.

---

## Epic 3: Transcrição e Cérebro (STT + LM Studio)
**Objetivo:** Converter o áudio do utilizador em texto e gerar a resposta lógica recorrendo a modelos alojados no hardware local.

### Sub-issue 3.1: Integração local do Whisper.cpp
*   **Descrição:** Invocar o binário pré-compilado do Whisper com o ficheiro WAV temporário para obter a transcrição exata.
*   **Requisitos:** Executável `whisper.cpp` funcional no Omarchy, modelo quantizado (ex: *base* ou *small*).
*   **Acceptance Criteria:**
    *   O Node.js consegue executar o comando shell, passar o caminho do áudio e extrair apenas o texto resultante do *stdout*.
    *   O texto limpo é passado para a cadeia seguinte de processamento (LLM).

### Sub-issue 3.2: Geração de resposta LLM em Stream
*   **Descrição:** Enviar o texto transcrito para a API local do LM Studio e receber a resposta em pedaços (tokens) para reduzir o tempo de reação.
*   **Requisitos:** Pacote `openai` (Node.js), servidor local do LM Studio ativo na porta padrão (1234).
*   **Acceptance Criteria:**
    *   A comunicação com o LM Studio não bloqueia a espera da resposta total.
    *   Os pedaços de texto vão sendo emitidos e capturados pelo Node.js à medida que são gerados pelo modelo GGUF.

### Sub-issue 3.3: Injeção de Persona e Restrições de Idioma
*   **Descrição:** Garantir que o comportamento do LLM cumpre a diretriz "Digital Noir": ser conciso, direto, sem listas/formatações e estritamente em português.
*   **Requisitos:** Configuração do array de mensagens de Contexto (System Prompt).
*   **Acceptance Criteria:**
    *   O assistente responde 100% das vezes em Português, independentemente de gírias técnicas usadas em inglês.
    *   As respostas recusam usar Markdown (sem asteriscos, *hashtags* ou pontos de lista), garantindo que a síntese de voz (TTS) lê tudo com naturalidade.

---

## Epic 4: Motor de Voz GPU e Chunking (Kokoro TTS)
**Objetivo:** Gerar voz humana em tempo real com hardware acceleration e orquestrar as respostas de forma sequencial para eliminar latências de espera.

### Sub-issue 4.1: Microserviço FastAPI para TTS com CUDA
*   **Descrição:** Construir uma API em Python que mantenha o modelo Kokoro carregado diretamente na VRAM da GPU, expondo um endpoint POST `/tts` para síntese de áudio em tempo real.
*   **Requisitos:** Python 3.10+, FastAPI, bibliotecas PyTorch CUDA (`onnxruntime-gpu`), modelos transformers do Kokoro.
*   **Implementação:** [`src/main/python_server/main.py`](./src/main/python_server/main.py) - endpoint `/tts` com resposta binária WAV; [`scripts/spawn-python-server.ts`](./scripts/spawn-python-server.ts) para spawn no background; requirements em [`src/main/python_server/requirements.txt`](./src/main/python_server/requirements.txt).
*   **Endpoint:** `POST /tts` aceita `{text, voice}`, retorna WAV audio como buffer binário.
*   **Health Check:** `GET /health` confirma readiness do servidor.
*   **Variáveis de Ambiente:** `KOKORO_MODEL_PATH` define caminho para diretório do modelo Kokoro GGUF (ex: `pf_dora`).
*   **Acceptance Criteria:**
    *   O serviço hospeda um endpoint POST `/tts` que aceita uma string com texto e voz.
    *   O modelo é mantido em memória quente (sem cold starts entre frases).
    *   O output é devolvido em formato binário de áudio (WAV) de forma imediata (inferência sub-segundo via GPU CUDA).
    *   O servidor inicia automaticamente ao arrancar a aplicação Electron e é encerrado limpo no close.

### Sub-issue 4.2: Configuração de Voz em Português
*   **Descrição:** Adaptar o motor TTS e os pacotes fonéticos para suportar o idioma de Camões de forma otimizada.
*   **Requisitos:** Ficheiros do modelo Kokoro específicos para português (ex: `pf_dora`).
*   **Acceptance Criteria:**
    *   O pipeline TTS está instanciado com o `lang_code` correto para português.
    *   A voz gerada respeita as regras de acentuação e entonação da língua.

### Sub-issue 4.3: Algoritmo de "Chunking" Dinâmico
*   **Descrição:** Dividir a cascata de tokens do LM Studio em frases gramaticais corretas que possam ser lidas, sem esperar pelo fim do parágrafo.
*   **Requisitos:** Lógica de manipulação de *buffers* e Expressões Regulares (RegEx) no Node.js.
*   **Acceptance Criteria:**
    *   O algoritmo acumula tokens e apenas envia dados ao TTS quando deteta sinais de conclusão (pontos finais, de interrogação, exclamação ou vírgulas estratégicas).
    *   As quebras não corrompem a sintaxe da frase enviada ao Kokoro.
*   **Issue #15:** Documentação completa do pipeline de shader Digital Noir em [`issues/15-shader-pipeline.md`](./issues/15-shader-pipeline.md) incluindo Epic-to-issue tracing, implementação FFT→uniform mapping, e validação de acceptance criteria AC-001/AC-002/AC-003.

### Sub-issue 4.4: Fila IPC e Reprodução Contínua
*   **Descrição:** Garantir que as frases geradas pelo servidor FastAPI são enviadas para a interface React e reproduzidas na ordem correta, sem encavalitar os áudios.
*   **Requisitos:** Gestão de concorrência e filas de processamento FIFO em TypeScript.
*   **Acceptance Criteria:**
    *   Se a frase 2 for gerada enquanto a frase 1 ainda está a ser lida, a frase 2 é colocada em *standby*.
    *   A transição sonora entre *chunks* reproduzidos é suave, criando a ilusão de uma resposta ininterrupta.

---

## Epic 5: Estética Digital Noir (Orbe Reativa)
**Objetivo:** Trazer a personagem do SPECTRE à vida com um elemento tridimensional dinâmico, enigmático e altamente responsivo.
*   **Documentation:** Complete pipeline documentation available in [`issues/15-shader-pipeline.md`](./issues/15-shader-pipeline.md).

### Sub-issue 5.1: Setup Base React-Three-Fiber
*   **Descrição:** Criar o contexto 3D e renderizar a geometria base do assistente no ecrã transparente do Electron.
*   **Requisitos:** Dependências `@react-three/fiber` e `three` instaladas e configuradas.
*   **Acceptance Criteria:**
    *   O Canvas tridimensional ocupa corretamente o espaço visual disponível sem quebrar o fundo transparente.
    *   Renderização de uma esfera 3D simples funcional a 60 fps constantes.

### Sub-issue 5.2: Programação do Custom Shader (GLSL)
*   **Descrição:** Substituir o material básico por um programa executado na gráfica para obter a estética *Noir* (pretos, escalas de cinza, minimalismo escuro).
*   **Requisitos:** Conhecimento de Vertex Shaders e Fragment Shaders (GLSL), implementação de ruído processual (Simplex Noise).
*   **Acceptance Criteria:**
    *   A orbe possui texturas dinâmicas geradas proceduralmente (sem imagens estáticas).
    *   A iluminação respeita as condicionantes estéticas de alto contraste (cores escuras predominantes com halos precisos).
    *   A geometria base distorce-se levemente com o tempo (animação *idle*).
*   **Implementation:** [`App.tsx`](./src/renderer/App.tsx) - Shader orbital com uniforms `time`, `amplitude`, `noiseTime`; Simplex Noise inline para textura procedimental; mapeamento FFT→uniform via `useFrame` ciclo.

### Sub-issue 5.3: Web Audio API (AnalyserNode)
*   **Descrição:** Interceptar o áudio proveniente do modelo TTS antes de ir para as colunas do utilizador para análise frequencial no browser.
*   **Requisitos:** Manipulação do `AudioContext` nativo da web e encaminhamento de instâncias `HTMLAudioElement`.
*   **Acceptance Criteria:**
    *   O áudio reproduzido é passado pelo `AnalyserNode` sem perda de qualidade sonora.
    *   A aplicação consegue extrair as variáveis do Fast Fourier Transform (FFT) em tempo real (frequências e volume do som).

### Sub-issue 5.4: Sincronização Áudio-Shader (Reactividade)
*   **Descrição:** Fundir o processamento de áudio com a interface 3D, fazendo com que a Orbe aja consoante as palavras que o SPECTRE profere.
*   **Requisitos:** Ciclos de atualização de interface (`useFrame`), manipulação de variáveis (*uniforms*) do shader.
*   **Acceptance Criteria:**
    *   Os dados de amplitude do `AnalyserNode` são injetados no shader a cada frame visual.
    *   A Orbe aumenta de volume e distorce os seus espigões/ondas procedurais consoante a agressividade ou tom das palavras pronunciadas pelo TTS.
    *   O efeito regressa suavemente à animação base (idle) assim que a fala termina.
