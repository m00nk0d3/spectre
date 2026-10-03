import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { ConversationState } from "@/types/ipc";
import type { TextPresentation } from "@/types/text-presentation";
import type {
  SandcastleIssuePlan,
  SandcastleProject,
  SandcastleWorkflow,
} from "@/types/sandcastle";
import type { GitHubMonitorSnapshot } from "@/types/github-monitor";
import type { ConversationMemorySnapshot } from "@/types/conversation-memory";
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

const ORB_BASE_SCALE = 0.72;
const ACTIVE_WORKFLOW_STATUSES = new Set(["queued", "running", "blocked"]);

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
        ORB_BASE_SCALE * (
          1 + idleBreath + values.amplitude * 0.42 + values.bass * 0.16
        ),
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

function PresentationContent({
  presentation,
}: {
  presentation: TextPresentation;
}) {
  const lines = presentation.content.split("\n");
  const listPattern = /^(?:-\s+|\d+[.)]\s+)\S/;
  const listItems = lines.filter((line) => listPattern.test(line));
  if (presentation.kind !== "instructions" && listItems.length >= 2) {
    const introduction = lines
      .filter((line) => line.trim() && !listPattern.test(line))
      .join(" ");
    return (
      <div className="presentation-content">
        {introduction && <p>{introduction}</p>}
        <ul className="presentation-list">
          {listItems.map((line, index) => (
            <li key={`${index}-${line}`}>
              {line.replace(/^(?:-\s+|\d+[.)]\s+)/, "")}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return <pre>{presentation.content}</pre>;
}

const STATE_LABELS: Record<ConversationState, string> = {
  idle: "Ready",
  listening: "Listening",
  transcribing: "Transcribing",
  thinking: "Thinking",
  speaking: "Speaking",
  error: "Error",
};

function WorkflowPanel({ onClose }: { onClose: () => void }) {
  const [projects, setProjects] = useState<SandcastleProject[]>([]);
  const [projectPath, setProjectPath] = useState("");
  const [issue, setIssue] = useState("");
  const [plans, setPlans] = useState<SandcastleIssuePlan[]>([]);
  const [workflows, setWorkflows] = useState<SandcastleWorkflow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async (selectedProject = projectPath) => {
    const [nextProjects, nextPlans] = await Promise.all([
      window.electron.listSandcastleProjects(),
      window.electron.listSandcastlePlans(),
    ]);
    setProjects(nextProjects);
    setPlans(nextPlans);
    const effectiveProject = selectedProject
      || nextProjects[0]?.path
      || "";
    if (!selectedProject && effectiveProject) setProjectPath(effectiveProject);
    if (effectiveProject) {
      setWorkflows(
        await window.electron.listSandcastleWorkflows(effectiveProject),
      );
    } else {
      setWorkflows([]);
    }
  };

  useEffect(() => {
    let active = true;
    const update = async () => {
      try {
        await refresh();
        if (active) setError("");
      } catch (refreshError) {
        if (active) {
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : String(refreshError),
          );
        }
      }
    };
    void update();
    const interval = window.setInterval(() => void update(), 2_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [projectPath]);

  const prepareIssue = async () => {
    const issueNumber = Number(issue);
    if (!projectPath || !Number.isSafeInteger(issueNumber) || issueNumber < 1) {
      setError("Choose a project and enter a positive issue number.");
      return;
    }
    setBusy(true);
    try {
      await window.electron.prepareSandcastleIssue({
        project: projectPath,
        issue: issueNumber,
      });
      setIssue("");
      await refresh(projectPath);
      setError("");
    } catch (prepareError) {
      setError(
        prepareError instanceof Error
          ? prepareError.message
          : String(prepareError),
      );
    } finally {
      setBusy(false);
    }
  };

  const startPlan = async (plan: SandcastleIssuePlan) => {
    setBusy(true);
    try {
      await window.electron.startSandcastlePlan({
        id: plan.id,
        hash: plan.hash,
      });
      setProjectPath(plan.project.path);
      await refresh(plan.project.path);
      setError("");
    } catch (startError) {
      setError(
        startError instanceof Error ? startError.message : String(startError),
      );
    } finally {
      setBusy(false);
    }
  };

  const openPlan = async (plan: SandcastleIssuePlan) => {
    try {
      await window.electron.openSandcastlePlan({
        id: plan.id,
        hash: plan.hash,
      });
      setError("");
    } catch (openError) {
      setError(
        openError instanceof Error ? openError.message : String(openError),
      );
    }
  };

  const stopWorkflow = async (workflow: SandcastleWorkflow) => {
    setBusy(true);
    try {
      await window.electron.stopSandcastleWorkflow({
        project: projectPath,
        runId: workflow.id,
      });
      await refresh(projectPath);
      setError("");
    } catch (stopError) {
      setError(
        stopError instanceof Error ? stopError.message : String(stopError),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="workflow-panel" aria-label="Sandcastle workflows">
      <header className="workflow-panel-header">
        <div>
          <span>Local control plane</span>
          <h2>Sandcastle</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose}>
          Close
        </button>
      </header>

      <section className="workflow-section">
        <label htmlFor="workflow-project">Project</label>
        <select
          id="workflow-project"
          value={projectPath}
          onChange={(event) => setProjectPath(event.target.value)}
          disabled={busy}
        >
          {projects.length === 0 && <option value="">No projects found</option>}
          {projects.map((project) => (
            <option key={project.path} value={project.path}>
              {project.name} · {project.branch || "detached"}
            </option>
          ))}
        </select>
        <div className="issue-plan-form">
          <input
            type="number"
            min="1"
            step="1"
            value={issue}
            onChange={(event) => setIssue(event.target.value)}
            placeholder="Issue number"
            aria-label="GitHub issue number"
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => void prepareIssue()}
            disabled={busy || !projectPath}
          >
            Prepare plan
          </button>
        </div>
      </section>

      {plans.length > 0 && (
        <section className="workflow-section">
          <h3>Awaiting review</h3>
          <div className="workflow-list">
            {plans.map((plan) => (
              <article className="workflow-card plan-card" key={plan.id}>
                <div className="workflow-card-heading">
                  <strong>{plan.title}</strong>
                  <span>expires {new Date(plan.expiresAt).toLocaleTimeString()}</span>
                </div>
                <p>{plan.summary}</p>
                <ul>
                  {plan.effects.map((effect) => (
                    <li key={effect}>{effect}</li>
                  ))}
                </ul>
                <div className="workflow-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void openPlan(plan)}
                    disabled={busy}
                  >
                    Open detailed plan
                  </button>
                  <button
                    type="button"
                    onClick={() => void startPlan(plan)}
                    disabled={busy}
                  >
                    Review and start
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="workflow-section workflow-runs">
        <h3>Workflow runs</h3>
        <div className="workflow-list">
          {workflows.length === 0 && (
            <p className="workflow-empty">No Sandcastle runs for this project.</p>
          )}
          {workflows.map((workflow) => (
            <article className="workflow-card" key={workflow.id}>
              <div className="workflow-card-heading">
                <strong>{workflow.title}</strong>
                <span className={`workflow-status status-${workflow.status}`}>
                  {workflow.status}
                </span>
              </div>
              <p>{workflow.current_step}</p>
              <div
                className="workflow-progress"
                aria-label={`${workflow.progress.percent}% complete`}
              >
                <span style={{ width: `${workflow.progress.percent}%` }} />
              </div>
              {workflow.agents.map((agent) => (
                <p className="workflow-agent" key={agent.id}>
                  {agent.name}: {agent.summary}
                </p>
              ))}
              {workflow.error && (
                <p className="workflow-error">{workflow.error}</p>
              )}
              {ACTIVE_WORKFLOW_STATUSES.has(workflow.status) && (
                <div className="workflow-actions">
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => void stopWorkflow(workflow)}
                    disabled={busy}
                  >
                    Stop workflow
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      {error && <p className="workflow-panel-error">{error}</p>}
    </aside>
  );
}

function GitHubActivityPanel({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<GitHubMonitorSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const removeListener = window.electron.onGitHubMonitorUpdate(
      (nextSnapshot) => {
        if (active) setSnapshot(nextSnapshot);
      },
    );
    void window.electron.getGitHubMonitorSnapshot()
      .then((nextSnapshot) => {
        if (active) setSnapshot(nextSnapshot);
      })
      .catch((snapshotError) => {
        if (active) {
          setError(
            snapshotError instanceof Error
              ? snapshotError.message
              : String(snapshotError),
          );
        }
      });
    return () => {
      active = false;
      removeListener();
    };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      setSnapshot(await window.electron.refreshGitHubMonitor());
      setError("");
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : String(refreshError),
      );
    } finally {
      setRefreshing(false);
    }
  };

  const shownError = error || snapshot?.error || "";

  return (
    <aside className="workflow-panel github-panel" aria-label="GitHub activity">
      <header className="workflow-panel-header">
        <div>
          <span>Observe and propose</span>
          <h2>GitHub activity</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose}>
          Close
        </button>
      </header>

      <section className="workflow-section github-monitor-summary">
        <div>
          <span>Account</span>
          <strong>{snapshot?.account ?? "Not connected"}</strong>
        </div>
        <div>
          <span>Repositories</span>
          <strong>{snapshot?.repositoryCount ?? 0}</strong>
        </div>
        <div>
          <span>Status</span>
          <strong>{snapshot?.status ?? "loading"}</strong>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing || snapshot?.status === "polling"}
        >
          {refreshing ? "Checking…" : "Check now"}
        </button>
      </section>

      <section className="workflow-section github-events">
        <h3>Pull request changes</h3>
        {snapshot?.lastCheckedAt && (
          <p className="github-last-checked">
            Last checked {new Date(snapshot.lastCheckedAt).toLocaleString()}
          </p>
        )}
        <div className="workflow-list">
          {snapshot?.events.length === 0 && (
            <p className="workflow-empty">
              Baseline established. New and updated pull requests will appear
              here without triggering GitHub writes.
            </p>
          )}
          {snapshot?.events.map((event) => (
            <article className="workflow-card github-event" key={event.id}>
              <div className="workflow-card-heading">
                <strong>
                  {event.repository} #{event.number}
                </strong>
                <span className="github-event-kind">
                  {event.kind.replaceAll("_", " ")}
                </span>
              </div>
              <p>{event.title}</p>
              <div className="github-event-meta">
                <span>{event.author}</span>
                <span>{event.draft ? "draft" : event.state}</span>
                <span>{new Date(event.detectedAt).toLocaleString()}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      {shownError && <p className="workflow-panel-error">{shownError}</p>}
    </aside>
  );
}

function MemoryPanel({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<ConversationMemorySnapshot | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void window.electron.getConversationMemory()
      .then((memory) => {
        if (active) setSnapshot(memory);
      })
      .catch((memoryError) => {
        if (active) {
          setError(
            memoryError instanceof Error
              ? memoryError.message
              : String(memoryError),
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const toggleMemory = async () => {
    if (!snapshot) return;
    setBusy(true);
    try {
      setSnapshot(
        await window.electron.setConversationMemoryEnabled(!snapshot.enabled),
      );
      setError("");
    } catch (toggleError) {
      setError(
        toggleError instanceof Error ? toggleError.message : String(toggleError),
      );
    } finally {
      setBusy(false);
    }
  };

  const clearMemory = async () => {
    setBusy(true);
    try {
      const cleared = await window.electron.clearConversationMemory();
      if (cleared) setSnapshot(cleared);
      setError("");
    } catch (clearError) {
      setError(
        clearError instanceof Error ? clearError.message : String(clearError),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="workflow-panel memory-panel" aria-label="Conversation memory">
      <header className="workflow-panel-header">
        <div>
          <span>Local and private</span>
          <h2>Conversation memory</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose}>
          Close
        </button>
      </header>

      <section className="workflow-section memory-summary">
        <div>
          <span>Status</span>
          <strong>{snapshot?.enabled ? "Remembering" : "Paused"}</strong>
        </div>
        <div>
          <span>Turns</span>
          <strong>{snapshot?.turnCount ?? 0}</strong>
        </div>
        <div>
          <span>Compacted</span>
          <strong>{snapshot?.summaryCount ?? 0}</strong>
        </div>
        <button type="button" onClick={() => void toggleMemory()} disabled={busy}>
          {snapshot?.enabled ? "Pause memory" : "Resume memory"}
        </button>
      </section>

      <section className="workflow-section memory-history">
        <h3>Recent remembered turns</h3>
        <div className="workflow-list">
          {snapshot?.recentTurns.length === 0 && (
            <p className="workflow-empty">
              No completed conversations have been remembered yet.
            </p>
          )}
          {snapshot?.recentTurns.map((turn) => (
            <article className="workflow-card memory-turn" key={turn.id}>
              <div className="workflow-card-heading">
                <strong>{new Date(turn.createdAt).toLocaleString()}</strong>
              </div>
              <p><span>You:</span> {turn.user}</p>
              <p><span>Spectre:</span> {turn.assistant}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="workflow-section memory-danger">
        <p>
          Memory is stored only in Spectre's local Electron data directory.
          Erasing it cannot be undone.
        </p>
        <button
          type="button"
          className="danger-button"
          onClick={() => void clearMemory()}
          disabled={busy || !snapshot || snapshot.turnCount === 0}
        >
          Erase all memory
        </button>
      </section>

      {error && <p className="workflow-panel-error">{error}</p>}
    </aside>
  );
}

export default function App() {
  const playbackQueue = useRef<AudioPlaybackQueue | null>(null);
  const stateRef = useRef<ConversationState>("idle");
  const [state, setState] = useState<ConversationState>("idle");
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [progress, setProgress] = useState("");
  const [taskItems, setTaskItems] = useState<Array<{
    step: number;
    message: string;
    status: "working" | "done" | "failed";
  }>>([]);
  const [error, setError] = useState("");
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  const [githubOpen, setGitHubOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [presentation, setPresentation] = useState<TextPresentation | null>(
    null,
  );

  useEffect(() => {
    if (!window.electron) {
      setState("error");
      setError("Electron bridge unavailable");
      return;
    }

    let vad: ReturnType<typeof createVad> | null = null;
    let disposed = false;
    const reportMicrophoneError = (vadError: unknown) => {
      setState("error");
      setError(
        `Microphone: ${
          vadError instanceof Error ? vadError.message : String(vadError)
        }`,
      );
    };
    const queue = new AudioPlaybackQueue();
    playbackQueue.current = queue;
    const removeConversationListener = window.electron.onConversationEvent(
      (event) => {
        if (event.type === "state") {
          stateRef.current = event.state;
          setState(event.state);
        }
        if (event.type === "transcript") {
          setTranscript(event.text);
          setProgress("");
          setTaskItems([]);
        }
        if (event.type === "text") setReply(event.text);
        if (event.type === "progress") {
          setProgress(event.message);
          setTaskItems((current) => {
            const completed = current.map((item) =>
              item.status === "working"
                ? { ...item, status: "done" as const }
                : item);
            const existingIndex = completed.findIndex(
              (item) =>
                item.step === event.step
                && item.message === event.message,
            );
            if (existingIndex >= 0) {
              completed[existingIndex] = {
                ...completed[existingIndex],
                status: "working",
              };
              return completed.slice(-8);
            }
            return [
              ...completed,
              {
                step: event.step,
                message: event.message,
                status: "working" as const,
              },
            ].slice(-8);
          });
          if (event.spokenHint) {
            void window.electron.getTTSAudio(event.spokenHint)
              .then((audio) => queue.enqueueImmediate(audio))
              .catch((hintError) => {
                setError(
                  hintError instanceof Error
                    ? hintError.message
                    : String(hintError),
                );
              });
          }
        }
        if (event.type === "complete") {
          setProgress("");
          setTaskItems((current) => current.map((item) => ({
            ...item,
            status: "done",
          })));
        }
        if (event.type === "presentation") {
          setWorkflowsOpen(false);
          setGitHubOpen(false);
          setMemoryOpen(false);
          setPresentation(event.presentation);
          if (event.presentation.spokenHint) {
            void window.electron.getTTSAudio(event.presentation.spokenHint)
              .then((audio) => queue.enqueueImmediate(audio))
              .catch((hintError) => {
                setError(
                  hintError instanceof Error
                    ? hintError.message
                    : String(hintError),
                );
              });
          }
        }
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
          setTaskItems((current) => current.map((item) =>
            item.status === "working"
              ? { ...item, status: "failed" }
              : item));
          setError(event.message);
          setState("error");
        }
      },
    );

    vad = createVad({
      onSpeechStart: async () => {
        queue.reset();
        setError("");
        if (stateRef.current === "speaking") {
          await window.electron.cancelConversation();
        }
        setState("listening");
        await window.electron.notifySpeechStart();
      },
      onSpeechEnd: async (audio) => {
        try {
          await window.electron.notifySpeechEnd();
          await window.electron.processConversation(audio);
        } catch (conversationError) {
          setState("error");
          setError(
            `Conversation: ${
              conversationError instanceof Error
                ? conversationError.message
                : String(conversationError)
            }`,
          );
        }
      },
      onError: (vadError) => {
        reportMicrophoneError(vadError);
      },
    });

    const startVadWhenReady = async () => {
      while (!disposed) {
        if (await window.electron.pythonStatusRequest()) {
          await vad?.start();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };
    void startVadWhenReady().catch(reportMicrophoneError);

    return () => {
      disposed = true;
      removeConversationListener();
      void window.electron.cancelConversation();
      void vad.cleanup();
      void queue.close();
      playbackQueue.current = null;
    };
  }, []);

  const closePresentation = (accepted: boolean) => {
    if (!presentation) return;
    if (presentation.requiresResponse) {
      void window.electron.respondToPresentation({
        id: presentation.id,
        accepted,
      });
    }
    setPresentation(null);
  };

  return (
    <main className="spectre-shell">
      <button
        type="button"
        className="workflow-toggle"
        onClick={() => {
          setGitHubOpen(false);
          setMemoryOpen(false);
          setWorkflowsOpen(true);
        }}
        aria-expanded={workflowsOpen}
      >
        Workflows
      </button>
      <button
        type="button"
        className="github-toggle"
        onClick={() => {
          setWorkflowsOpen(false);
          setMemoryOpen(false);
          setGitHubOpen(true);
        }}
        aria-expanded={githubOpen}
      >
        GitHub
      </button>
      <button
        type="button"
        className="memory-toggle"
        onClick={() => {
          setWorkflowsOpen(false);
          setGitHubOpen(false);
          setMemoryOpen(true);
        }}
        aria-expanded={memoryOpen}
      >
        Memory
      </button>
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
        {taskItems.length > 0 && (
          <aside className="agent-task-list" aria-label="Current task list">
            <header>Current task</header>
            <ol>
              {taskItems.map((item, index) => (
                <li
                  key={`${item.step}-${index}-${item.message}`}
                  className={`task-${item.status}`}
                >
                  <span aria-hidden="true" />
                  <p>{item.message}</p>
                </li>
              ))}
            </ol>
          </aside>
        )}
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
          {progress && (
            <article className="transcript-entry transcript-progress">
              <span>Working</span>
              <p>{progress}</p>
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
      {workflowsOpen && (
        <WorkflowPanel onClose={() => setWorkflowsOpen(false)} />
      )}
      {githubOpen && (
        <GitHubActivityPanel onClose={() => setGitHubOpen(false)} />
      )}
      {memoryOpen && (
        <MemoryPanel onClose={() => setMemoryOpen(false)} />
      )}
      {presentation && (
        <section
          className="presentation-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="presentation-title"
        >
          <article className="presentation-panel">
            <header>
              <div>
                <span>{presentation.kind}</span>
                <h2 id="presentation-title">{presentation.title}</h2>
              </div>
              {!presentation.requiresResponse && (
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => closePresentation(false)}
                  aria-label="Close presentation"
                >
                  Close
                </button>
              )}
            </header>
            <PresentationContent presentation={presentation} />
            <footer>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void navigator.clipboard.writeText(presentation.content);
                }}
              >
                Copy text
              </button>
              {presentation.requiresResponse && (
                <>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => closePresentation(false)}
                  >
                    {presentation.cancelLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => closePresentation(true)}
                  >
                    {presentation.confirmLabel}
                  </button>
                </>
              )}
            </footer>
          </article>
        </section>
      )}
    </main>
  );
}
