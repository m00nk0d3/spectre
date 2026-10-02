import { getTTSServerUrl } from "../../scripts/spawn-python-server";

export async function synthesizeSpeech(
  text: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(`${getTTSServerUrl()}/tts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice: process.env.TTS_VOICE || "pf_dora",
    }),
    signal,
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `Kokoro returned ${response.status}: ${details || response.statusText}`,
    );
  }

  return response.arrayBuffer();
}
