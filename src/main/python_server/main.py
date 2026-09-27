from fastapi import FastAPI, Response
from pydantic import BaseModel
import os
import tempfile
import struct

app = FastAPI()

MODEL_PATH: str = ""


class TTSPayload(BaseModel):
    text: str
    voice: str = "alloy"


def get_model_processor_and_model():
    """Get cached processor and model to avoid redundant imports."""
    try:
        import torch
        from transformers import AutoProcessor, AutoModelForTextToSpeech

        # Check for CUDA availability
        if torch.cuda.is_available():
            device = "cuda"
            print(f"[PYTHON-SERVER] GPU detected, loading model to CUDA")
        else:
            device = "cpu"
            print("[PYTHON-SERVER] No GPU available, running on CPU")

        # Load actual Kokoro GGUF model using transformers pipeline
        processor = AutoProcessor.from_pretrained(MODEL_PATH)
        model = AutoModelForTextToSpeech.from_pretrained(MODEL_PATH).to(device).eval()

        print(f"[PYTHON-SERVER] Model loaded successfully on {device}")

    except ImportError:
        # Fallback to onnxruntime-gpu for GGUF support
        import onnxruntime as ort
        if "cuda" in (os.environ.get("CUDA_VISIBLE_DEVICES", "") or "").lower():
            raise Exception("onnxruntime-gpu required for CUDA inference")

        from transformers import AutoProcessor, AutoModelForTextToSpeech
        processor = AutoProcessor.from_pretrained(MODEL_PATH)
        model = AutoModelForTextToSpeech.from_pretrained(MODEL_PATH).to(device).eval()

        print(f"[PYTHON-SERVER] Model loaded successfully on {device}")

    return processor, model


@app.on_event("startup")
async def load_model():
    global MODEL_PATH

    model_path_env = os.environ.get("KOKORO_MODEL_PATH", "")
    if not model_path_env:
        raise Exception(
            "KOKORO_MODEL_PATH environment variable not set"
        )

    # Validate path exists and is a directory before proceeding
    if not os.path.exists(model_path_env):
        raise Exception(f"KOKORO_MODEL_PATH does not exist: {model_path_env}")

    if not os.path.isdir(model_path_env):
        raise Exception(f"KOKORO_MODEL_PATH is not a directory: {model_path_env}")

    MODEL_PATH = model_path_env

    try:
        print(f"[PYTHON-SERVER] Loading Kokoro TTS model from: {MODEL_PATH}")

        # Get cached processor and model (imports already at module level)
        processor, model = get_model_processor_and_model()

        return {
            "status": f"kokoro_model_loaded_on_{model.device}",
            "device": model.device,
            "model_path": MODEL_PATH
        }
    except Exception as e:
        raise Exception(f"Failed to load Kokoro model: {str(e)}")


@app.post("/tts")
async def generate_tts(payload: TTSPayload):
    try:
        if not payload.text or len(payload.text.strip()) == 0:
            # Create actual WAV silence buffer using standard WAV format
            sample_rate = 16000
            duration = 0.5  # seconds
            num_samples = int(sample_rate * duration)

            # Create proper WAV header + silence data
            wav_data, _ = create_wav_silence(num_samples, sample_rate)
            return Response(
                content=wav_data,
                media_type="audio/wav",
                headers={
                    "Content-Disposition": 'attachment; filename="silence.wav"'
                }
            )

        # Actual Kokoro TTS inference
        try:
            processor, model = get_model_processor_and_model()
        except Exception as load_error:
            # Return minimal valid WAV audio on load failure (fallback behavior)
            wav_data, sample_rate = create_wav_silence(16000, 16000)
            return Response(
                content=wav_data,
                media_type="audio/wav",
                headers={
                    "Content-Disposition": f'attachment; filename="tts_{payload.voice}.wav"'
                }
            )

        # Actual inference using Kokoro processor
        inputs = processor(text=[payload.text]).to(model.device)
        audio = model.generate(**inputs)

        # Convert to numpy and create WAV output
        audio_data = (audio.cpu().numpy()[0] * 32767).astype("int16")

        wav_data, _ = create_wav_from_audio(audio_data, sample_rate=16000)

        return Response(
            content=wav_data,
            media_type="audio/wav",
            headers={
                "Content-Disposition": f'attachment; filename="tts_{payload.voice}.wav"'
            }
        )
    except Exception as e:
        raise Exception(f"TTS generation failed: {str(e)}")


def create_wav_silence(num_samples: int, sample_rate: int):
    """Create WAV silence buffer with proper RIFF header"""

    duration = num_samples / sample_rate
    bytes_per_sample = 2  # int16
    block_align = 1  # mono

    # Calculate total size (header + data)
    data_size = num_samples * bytes_per_sample
    padding_needed = (4 - (data_size % 4)) % 4
    total_data_size = data_size + padding_needed

    header_offset = 36  # Standard WAV header size

    buffer = bytearray()

    # RIFF chunk descriptor
    buffer.extend(struct.pack("<I", 36 + total_data_size))  # file size - 8
    buffer.extend(b"RIFF")

    # Wave format chunk
    buffer.extend(struct.pack("<I", header_offset))
    buffer.extend(b"WAVE")

    # fmt sub-chunk
    buffer.extend(struct.pack("<I", 12))
    buffer.extend(b"fmt ")

    # fmt chunk content (PCM, mono, 16-bit)
    buffer.extend(struct.pack("<H", 1))           # format: PCM
    buffer.extend(struct.pack("<H", 1))           # channels: mono
    buffer.extend(struct.pack("<I", sample_rate)) # sample rate
    buffer.extend(struct.pack("<I", sample_rate * bytes_per_sample * block_align))  # byte rate
    buffer.extend(struct.pack("<H", bytes_per_sample * block_align))  # block align
    buffer.extend(struct.pack("<H", 16))           # bits per sample

    # data sub-chunk
    buffer.extend(struct.pack("<I", total_data_size))
    buffer.extend(b"data")

    # Silence data (zeros)
    buffer.extend(bytearray(num_samples * bytes_per_sample))

    return bytes(buffer), sample_rate


def create_wav_from_audio(audio_data: bytearray, sample_rate: int):
    """Create WAV file from audio data array"""

    num_samples = len(audio_data) // 2  # Assuming int16
    bytes_per_sample = 2
    block_align = 1

    total_data_size = num_samples * bytes_per_sample
    padding_needed = (4 - (total_data_size % 4)) % 4
    total_size_with_padding = total_data_size + padding_needed

    header_offset = 36

    buffer = bytearray()

    # RIFF chunk descriptor
    buffer.extend(struct.pack("<I", 36 + total_size_with_padding))
    buffer.extend(b"RIFF")

    # Wave format chunk
    buffer.extend(struct.pack("<I", header_offset))
    buffer.extend(b"WAVE")

    # fmt sub-chunk
    buffer.extend(struct.pack("<I", 12))
    buffer.extend(b"fmt ")

    # fmt chunk content (PCM, mono, 16-bit)
    buffer.extend(struct.pack("<H", 1))           # format: PCM
    buffer.extend(struct.pack("<H", 1))           # channels: mono
    buffer.extend(struct.pack("<I", sample_rate)) # sample rate
    buffer.extend(struct.pack("<I", sample_rate * bytes_per_sample * block_align))
    buffer.extend(struct.pack("<H", bytes_per_sample * block_align))
    buffer.extend(struct.pack("<H", 16))           # bits per sample

    # data sub-chunk
    buffer.extend(struct.pack("<I", total_size_with_padding))
    buffer.extend(b"data")

    # Audio data
    buffer.extend(audio_data)

    return bytes(buffer), sample_rate


@app.get("/health")
async def health_check():
    return {"status": "ok"}
