import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { ConversationState } from "@/types/ipc";
import "../styles/index.css";
import {
  AudioPlaybackQueue,
  type AudioAnalysis,
} from "./audio-playback-queue";
import { createVad } from "./vad";

interface ShaderOrbProps {
  playbackQueue: React.MutableRefObject<AudioPlaybackQueue | null>;
}

const IDLE_ANALYSIS: AudioAnalysis = {
  amplitude: 0,
  bass: 0,
  treble: 0,
  isPlaying: false,
};

function ShaderOrb({ playbackQueue }: ShaderOrbProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const smoothed = useRef({ amplitude: 0, bass: 0, treble: 0 });
  const material = useMemo(() => new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uAmplitude: { value: 0 },
      uBass: { value: 0 },
      uTreble: { value: 0 },
    },
    vertexShader: `
      uniform float uTime;
      uniform float uAmplitude;
      uniform float uBass;
      uniform float uTreble;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying float vNoise;

      float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }

      float noise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
              mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
          mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
              mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
          f.z
        );
      }

      void main() {
        float slowNoise = noise(position * 2.7 + vec3(uTime * 0.16));
        float detail = sin(position.y * 13.0 + uTime * 2.5) * uTreble;
        float strength = 0.045 + uAmplitude * 0.28 + uBass * 0.18;
        float displacement = (slowNoise - 0.5) * strength + detail * 0.025;
        vec3 displaced = position + normal * displacement;
        vNoise = slowNoise;
        vNormal = normalize(normalMatrix * normal);
        vec4 viewPosition = modelViewMatrix * vec4(displaced, 1.0);
        vViewPosition = -viewPosition.xyz;
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uAmplitude;
      uniform float uBass;
      uniform float uTreble;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying float vNoise;

      void main() {
        vec3 viewDirection = normalize(vViewPosition);
        float facing = clamp(dot(normalize(vNormal), viewDirection), 0.0, 1.0);
        float rim = pow(1.0 - facing, 2.5);
        float grain = smoothstep(0.32, 0.78, vNoise);
        float pulse = 0.5 + 0.5 * sin(uTime * 1.15);

        vec3 black = vec3(0.006, 0.008, 0.012);
        vec3 graphite = vec3(0.035, 0.045, 0.060);
        vec3 steel = vec3(0.35, 0.52, 0.68);
        vec3 electric = vec3(0.70, 0.90, 1.00);
        vec3 surface = mix(black, graphite, facing + grain * 0.18);
        vec3 halo = mix(steel, electric, uTreble) *
          rim * (0.75 + uAmplitude * 2.8 + uBass * 1.4);
        surface += halo + electric * pulse * 0.025;

        float alpha = clamp(0.30 + facing * 0.34 + rim * 0.66, 0.0, 1.0);
        gl_FragColor = vec4(surface, alpha);
      }
    `,
  }), []);

  useEffect(() => () => material.dispose(), [material]);

  useFrame(({ clock }) => {
    const analysis = playbackQueue.current?.analyze() ?? IDLE_ANALYSIS;
    const attack = analysis.isPlaying ? 0.24 : 0.07;
    const values = smoothed.current;
    values.amplitude += (analysis.amplitude - values.amplitude) * attack;
    values.bass += (analysis.bass - values.bass) * attack;
    values.treble += (analysis.treble - values.treble) * attack;

    const time = clock.elapsedTime;
    material.uniforms.uTime.value = time;
    material.uniforms.uAmplitude.value = values.amplitude;
    material.uniforms.uBass.value = values.bass;
    material.uniforms.uTreble.value = values.treble;

    if (meshRef.current) {
      const idleBreath = Math.sin(time * 1.15) * 0.012;
      meshRef.current.scale.setScalar(
        1 + idleBreath + values.amplitude * 0.42 + values.bass * 0.16,
      );
      meshRef.current.rotation.y = time * 0.055;
      meshRef.current.rotation.x = Math.sin(time * 0.17) * 0.08;
    }
  });

  return (
    <mesh ref={meshRef}>
      <icosahedronGeometry args={[1, 7]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

const STATE_LABELS: Record<ConversationState, string> = {
  idle: "Ready",
  listening: "Listening",
  transcribing: "Transcribing",
  thinking: "Thinking",
  speaking: "Speaking",
  error: "Error",
};

export default function App() {
  const playbackQueue = useRef<AudioPlaybackQueue | null>(null);
  const [state, setState] = useState<ConversationState>("idle");
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!window.electron) {
      setState("error");
      setError("Electron bridge unavailable");
      return;
    }

    const queue = new AudioPlaybackQueue();
    playbackQueue.current = queue;
    const removeConversationListener = window.electron.onConversationEvent(
      (event) => {
        if (event.type === "state") setState(event.state);
        if (event.type === "transcript") setTranscript(event.text);
        if (event.type === "text") setReply(event.text);
        if (event.type === "audio") {
          void queue.enqueue(event.sequence, event.data).catch((queueError) => {
            setState("error");
            setError(
              queueError instanceof Error
                ? queueError.message
                : String(queueError),
            );
          });
        }
        if (event.type === "error") {
          setError(event.message);
          setState("error");
        }
      },
    );

    const vad = createVad({
      onSpeechStart: async () => {
        queue.reset();
        setTranscript("");
        setReply("");
        setError("");
        await window.electron.cancelConversation();
        setState("listening");
        await window.electron.notifySpeechStart();
      },
      onSpeechEnd: async (audio) => {
        await window.electron.notifySpeechEnd();
        await window.electron.processConversation(audio);
      },
      onError: (vadError) => {
        setState("error");
        setError(`Microphone: ${vadError.message}`);
      },
    });

    void vad.start().catch((vadError: unknown) => {
      setState("error");
      setError(
        `Could not start the microphone: ${
          vadError instanceof Error ? vadError.message : String(vadError)
        }`,
      );
    });

    return () => {
      removeConversationListener();
      void window.electron.cancelConversation();
      void vad.cleanup();
      void queue.close();
      playbackQueue.current = null;
    };
  }, []);

  return (
    <main className="spectre-shell">
      <section className="orb-stage" aria-label="Spectre orb">
        <Canvas
          className="orb-canvas"
          camera={{ position: [0, 0, 3.15], fov: 42 }}
          dpr={[1, 2]}
          gl={{ alpha: true, antialias: true, premultipliedAlpha: false }}
          onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
        >
          <ShaderOrb playbackQueue={playbackQueue} />
        </Canvas>
        <div className={`state state-${state}`}>
          <span className="state-dot" aria-hidden="true" />
          {STATE_LABELS[state]}
        </div>
      </section>
      <section className="transcript-view" aria-live="polite">
        <header>Transcript</header>
        <div className="transcript-content">
          {!transcript && !reply && !error && (
            <p className="transcript-placeholder">
              Talk to Spectre to start a conversation.
            </p>
          )}
          {transcript && (
            <article className="transcript-entry transcript-user">
              <span>You</span>
              <p>{transcript}</p>
            </article>
          )}
          {reply && (
            <article className="transcript-entry transcript-spectre">
              <span>Spectre</span>
              <p>{reply}</p>
            </article>
          )}
          {error && <p className="error-message">{error}</p>}
        </div>
      </section>
    </main>
  );
}
