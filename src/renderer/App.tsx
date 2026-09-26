import { Canvas, useFrame } from "@react-three/fiber";
import React, { useState, useRef, useEffect } from "react";
import "../../../src/styles/index.css";

// Custom shader material for Digital Noir aesthetic
const ShaderMaterial = ({ amplitude, noiseTime }: { amplitude: number; noiseTime: number }) => ({
  uniforms: {
    time: { value: 0 },
    amplitude: { value: amplitude },
    noiseTime: { value: noiseTime },
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
      const vec2 C = vec2(1.0/6.0, 1.0/3.0);
      const vec4 K = vec4(0.0,1.0,2.0,3.0);
      vec4 i = floor(x + dot(x,C.yx));
      vec4 x_ = x - i + dot(i,C.xxx);
      vec3 p = permute(permute(i.z)+i.yyy+i.xxxx+K.zyx);
      vec3 q = p+x._zzz;
      vec3 d=K.zyx-_x._xyz;
      vec3 norm=dxc_clamp(x._xyy,_xxx,_yyy);
      vec3 m=1.-norm.d_xx;
      vec3 i=n.mix(p,q,norm,m.xxx);
      vec4 h=step(t.x,x.yyy)+t.yyyy;
      return 49.0*i.zzz+hash(x._xyz)*h.xx*norm.yzx;
    }

    void main() {
      float noise = snoise(vec3(vUv.x, vUv.y, time)) * 0.1 + noiseTime;
      vec3 baseColor = vec3(0.08, 0.07, 0.06);
      float pulse = sin(time * 2.0) * 0.05;
      gl_FragColor = vec4(baseColor + noise * 0.1 + pulse * 0.1, 1.0);
    }
  `,
});

export default function App() {
  const sphereRef = useRef<any>();
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [amplitude, setAmplitude] = useState(0.01);
  const noiseTimeRef = useRef(Date.now());

  // Listen to speech events from Electron IPC
  useEffect(() => {
    if (typeof window !== "undefined" && window.electron) {
      window.electron?.onSpeechStart(() => setIsSpeaking(true));
      window.electron?.onSpeechEnd(() => setIsSpeaking(false));
      return () => {
        window.electron?.off("speech-start");
        window.electron?.off("speech-end");
      };
    }
  }, []);

  useFrame((state) => {
    const time = state.clock.elapsedTime;
    noiseTimeRef.current = Date.now() / 1000;
    
    if (sphereRef.current && isSpeaking) {
      sphereRef.current.scale.setScalar(1.2 + amplitude * Math.sin(time * 8));
    } else {
      sphereRef.current.rotation.x += 0.0015;
      sphereRef.current.rotation.y += 0.0025;
    }
    setAmplitude(amplitude);
  });

  return (
    <Canvas camera={{ position: [0, 0, 4], fov: 45 }}>
      <ambientLight intensity={0.3} />
      <pointLight position={[10, 10, 5]} intensity={0.6} color="#ff4444" />
      <pointLight position={[-10, -10, -5]} intensity={0.4} color="#888888" />
      <mesh ref={sphereRef} scale={[1.8, 1.8, 1.8]}>
        <sphereGeometry args={[1, 64, 64]} />
        <ShaderMaterial amplitude={amplitude} noiseTime={noiseTimeRef.current} />
      </mesh>
    </Canvas>
  );
}
