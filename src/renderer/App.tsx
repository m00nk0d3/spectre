import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useRef, useEffect } from "react";
import "../../../src/styles/index.css";

declare global {
  interface Window {
    electron: {
      notifySpeechStart: () => boolean;
      notifySpeechEnd: () => boolean;
    };
  }
}

// Custom shader material for Digital Noir aesthetic
function ShaderOrb({ amplitude }: { amplitude: number }) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const noiseTimeRef = useRef(Date.now());

  useFrame(({ clock }) => {
    const time = clock.elapsedTime;
    noiseTimeRef.current = Date.now() / 1000;

    if (meshRef.current) {
      meshRef.current.scale.setScalar(1.2 + amplitude * Math.sin(time * 8));
    } else {
      // Handle case where mesh is not yet initialized
    }
  });

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

      // Simplex noise for procedural texture
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

  return (
    <mesh ref={meshRef} scale={[1.8, 1.8, 1.8]}>
      <sphereGeometry args={[1, 64, 64]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

export default function App() {
  const amplitudeRef = useRef(0.01);

  // Wire speech events from Electron IPC bridge
  useEffect(() => {
    if (typeof window !== "undefined" && window.electron) {
      window.electron.notifySpeechStart();
      window.electron.notifySpeechEnd();
    }
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
