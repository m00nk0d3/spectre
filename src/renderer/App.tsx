import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useRef, useEffect } from "react";
import "../styles/index.css";
import { vadModule } from "./vad";

// Apply transparent background globally to ensure full transparency
const root = document.getElementById("root");
if (root) {
  root.style.backgroundColor = "transparent";
}

declare global {
  interface Window {
    electron: {
      notifySpeechStart: () => boolean;
      notifySpeechEnd: () => boolean;
      createWavBuffer?: (float32Data: Float32Array) => Promise<{ success: boolean; buffer: ArrayBuffer }>;
      vadGetCollectedAudio?: (config?: { sampleRate?: number; channels?: number }) => Promise<any>;
      vadTriggerWavConversion?: (config?: { sampleRate?: number; channels?: number }) => Promise<any>;
      sendAudioBuffer?: (float32Data: Float32Array | Buffer) => Promise<{ success: boolean; buffer?: ArrayBuffer }>;
    };
  }
}

function ShaderOrb({ amplitude }: { amplitude: number }) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const noiseTimeRef = useRef(Date.now());
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);

  useEffect(() => {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        amplitude: { value: amplitude },
        noiseTime: { value: noiseTimeRef.current },
      },
      vertexShader: `
        uniform float time;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float time;
        uniform float amplitude;
        uniform float noiseTime;
        varying vec2 vUv;

        float hash(float n) { return fract(sin(n * 1e4) * 1e4); }
        float snoise(vec3 x) {
          const vec2 C = vec2(1.0 / 3.0, 1.0 / 6.0);
          const vec4 K = vec4(1.0, 2.0, 3.0, 4.0);
          vec4 i = floor(x + dot(x, C.yx));
          vec4 x_ = x - i + dot(i, C.xxx);
          vec3 p = permute(permute(i.x) + i.y * i.z + K.zyx);
          vec3 q = p + x._xxx;
          vec3 r = q + x._xyz;
          float norm = smoothstep(0.0, 0.65, x.yzw);
          return fract(49.0 * i.zzz + hash(x) * step(0.25, x.x));
        }

        void main() {
          float noise = snoise(vec3(vUv.x, vUv.y, time)) * 0.1 + noiseTime;
          vec3 baseColor = vec3(0.08, 0.07, 0.06);
          float pulse = sin(time * 2.0) * 0.05;
          gl_FragColor = vec4(baseColor + noise * 0.1 + pulse * 0.1, 1.0);
        }
      `,
    });

    materialRef.current = material;

    return () => {
      if (materialRef.current) {
        materialRef.current.dispose();
        materialRef.current = null;
      }
    };
  }, [amplitude]);

  useFrame(({ clock }) => {
    const time = clock.elapsedTime;
    noiseTimeRef.current = Date.now() / 1000;

    if (meshRef.current && materialRef.current) {
      meshRef.current.scale.setScalar(1.2 + amplitude * Math.sin(time * 8));
      materialRef.current.uniforms.time.value = time;
      materialRef.current.uniforms.noiseTime.value = noiseTimeRef.current;
    }
  });

  return (
    <mesh ref={meshRef} scale={[1.8, 1.8, 1.8]}>
      <sphereGeometry args={[1, 64, 64]} />
      <primitive object={materialRef.current} attach="material" />
    </mesh>
  );
}

export default function App() {
  const amplitudeRef = useRef(0.01);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // Wire speech events from Electron IPC bridge
  useEffect(() => {
    if (typeof window !== "undefined" && window.electron) {
      const initializeVAD = async () => {
        try {
          await vadModule.start();
          window.electron.notifySpeechStart();
        } catch (err) {
          console.error("[VAD] Start failed:", err);
        }
      };

      initializeVAD();
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    const cleanup = () => {
      vadModule.cleanup();
    };

    return cleanup;
  });

  // Audio capture and conversion handler
  useEffect(() => {
    if (typeof window !== "undefined" && !window.electron) {
      console.warn("[APP] Electron bridge not available");
      return;
    }

    const setupAudioCapture = async () => {
      try {
        audioContextRef.current = new AudioContext();

        // Setup microphone input for real-time capture during speech
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

          sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);

          // Create script processor or use AudioWorklet for real-time capture
          const bufferSize = 4096;
          const scriptNode = audioContextRef.current.createScriptProcessor(bufferSize, 1, 1);

          scriptNode.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            const outputData = e.outputBuffer.getChannelData(0);

            // Pass-through to avoid feedback
            for (let i = 0; i < inputData.length; i++) {
              outputData[i] = inputData[i];

              // Convert to Float32 and capture during speech state
              if (vadModule.state.isSpeaking) {
                const buffer = new Float32Array([inputData[i]]);
                vadModule.addCollectedBuffer(buffer);
              }
            }
          };

          sourceRef.current.connect(scriptNode);
          scriptNode.connect(audioContextRef.current.destination);
        }

        // Set up real-time amplitude monitoring for visualization
        const monitorAmplitude = () => {
          if (!audioContextRef.current) return;

          // Analyze microphone input (if connected)
          if (sourceRef.current) {
            try {
              const scriptNode = audioContextRef.current.createScriptProcessor(512, 1, 1);
              const dataArray = new Float32Array(512);

              scriptNode.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                for (let i = 0; i < inputData.length && i < dataArray.length; i++) {
                  dataArray[i] = inputData[i];
                }

                // Calculate RMS amplitude
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                  sum += dataArray[i] * dataArray[i];
                }
                const rms = Math.sqrt(sum / dataArray.length);

                // Update visualization
                if (rms > 0.01) {
                  amplitudeRef.current = Math.min(amplitudeRef.current + (rms - amplitudeRef.current) * 0.1, 0.3);
                } else if (amplitudeRef.current > 0.01) {
                  // Smoothly decay
                  amplitudeRef.current *= 0.95;
                }
              };

              sourceRef.current.connect(scriptNode);
              scriptNode.connect(audioContextRef.current.destination);
            } catch (err) {
              console.warn("[APP] Amplitude monitoring failed:", err);
            }
          }
        };

        rafIdRef.current = requestAnimationFrame(monitorAmplitude);

      } catch (err) {
        console.error("[APP] Audio capture setup failed:", err);
      } finally {
        const ctx = audioContextRef.current;
        if (ctx && ctx.state !== "closed") {
          ctx.close().catch(console.error);
        }
      }

      // Set up real-time amplitude monitoring for visualization
      const monitorAmplitude = () => {
        if (!audioContextRef.current) return;

        // Analyze microphone input (if connected)
        if (sourceRef.current) {
          try {
            const scriptNode = audioContextRef.current.createScriptProcessor(512, 1, 1);
            const dataArray = new Float32Array(512);

            scriptNode.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              for (let i = 0; i < inputData.length && i < dataArray.length; i++) {
                dataArray[i] = inputData[i];
              }

              // Calculate RMS amplitude
              let sum = 0;
              for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i] * dataArray[i];
              }
              const rms = Math.sqrt(sum / dataArray.length);

              // Update visualization
              if (rms > 0.01) {
                amplitudeRef.current = Math.min(amplitudeRef.current + (rms - amplitudeRef.current) * 0.1, 0.3);
              } else if (amplitudeRef.current > 0.01) {
                // Smoothly decay
                amplitudeRef.current *= 0.95;
              }
            };

            sourceRef.current.connect(scriptNode);
            scriptNode.connect(audioContextRef.current.destination);
          } catch (err) {
            console.warn("[APP] Amplitude monitoring failed:", err);
          }
        }
      };

      rafIdRef.current = requestAnimationFrame(monitorAmplitude);

      monitorAmplitude();

      return () => {
        if (rafIdRef.current) {
          cancelAnimationFrame(rafIdRef.current);
        }

        const ctx = audioContextRef.current;
        if (sourceRef.current && ctx && ctx.state !== "closed") {
          sourceRef.current.disconnect();
        }

        if (ctx && ctx.state !== "closed") {
          ctx.close().catch(console.error);
        }
      }
    };

    // Cleanup audio context on unmount

    const cleanupAudio = () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }

      const ctx = audioContextRef.current;
      if (sourceRef.current && ctx && ctx.state !== "closed") {
        sourceRef.current.disconnect();
      }

      if (ctx && ctx.state !== "closed") {
        ctx.close().catch(console.error);
      }
    };

    window.electron.notifySpeechStart = () => {
      if (!audioContextRef.current) return false;

      amplitudeRef.current = 0.2;

      console.log("[APP] Audio capture enabled");
      return true;
    };

    window.electron.notifySpeechEnd = () => {
      if (vadModule.state.isSpeaking) {
        vadModule.state.isSpeaking = false;

        // Trigger audio conversion to WAV on speech end
        if (typeof window.electron.createWavBuffer === "function") {
          try {
            const collectedData: Float32Array[] = [];

            // Flatten all collected buffers from VAD
            for (const buf of vadModule.collectedBuffers) {
              collectedData.push(buf);
            }

            if (collectedData.length > 0) {
              const totalLength = collectedData.reduce((a, b) => a + b.length, 0);
              const flattenedData = new Float32Array(totalLength);

              let offset = 0;
              for (const buf of collectedData) {
                flattenedData.set(buf, offset);
                offset += buf.length;
              }

              // Convert to WAV buffer (fire and forget - conversion happens in IPC handler)
              window.electron.createWavBuffer(flattenedData).then((result) => {
                if (result.success && result.buffer) {
                  console.log("[APP] Audio converted to WAV successfully");
                } else {
                  console.error("[APP] WAV conversion failed");
                }

                // Clear collected buffers after conversion
                vadModule.collectedBuffers.length = 0;
              }).catch((err) => {
                console.error("[APP] WAV conversion error:", err);
              });
            }
          } catch (err) {
            console.error("[APP] WAV conversion error:", err);
          } finally {
            // Cleanup can go here if needed
          }
        }
      }

      console.log("[APP] Audio capture disabled");
      return true;
    };

    setupAudioCapture(); return cleanupAudio;

  }, []);

  return (
    <Canvas camera={{ position: [0, 0, 4], fov: 45 }}>
      <ambientLight intensity={0.3} />
      <pointLight position={[10, 10, 5]} intensity={0.6} color="#ff4444" />
      <pointLight position={[-10, -10, -5]} intensity={0.4} color="#888888" />
      <ShaderOrb amplitude={amplitudeRef.current} />
    </Canvas>
  );
}
