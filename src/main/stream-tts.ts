export interface LMStudioStreamingConfig {
  apiKey: string;
  timeoutMs?: number;
}

/**
 * Returns a readable stream of audio chunks from LM Studio TTS endpoint.
 * Each chunk is an ArrayBuffer containing MP3 data (or WAV if response_format set).
 */
export async function* streamTTSAudio(
  text: string,
  config: LMStudioStreamingConfig
): AsyncGenerator<{ seq: number; data: ArrayBuffer }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs ?? 30000);

  let sequence = 0;

  try {
    const response = await fetch("http://localhost:1234/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice: "alloy",
        response_format: "mp3"
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const statusText = response.statusText || "";
      throw new Error(`TTS API returned ${response.status}: ${statusText}`);
    }

    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        yield { seq: sequence, data: new ArrayBuffer(0) }; // Complete signal with empty buffer
        break;
      }

      yield { seq: ++sequence, data: new Uint8Array(value) };
    }
  } catch (error) {
    // Handle stream errors appropriately
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("TTS stream timed out");
    } else {
      throw error;
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
