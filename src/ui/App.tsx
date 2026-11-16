import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

type Project = { path: string; name: string };

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function chooseProject() {
    setError("");
    try {
      const path = await open({
        directory: true,
        multiple: false,
        title: "Choose an art project folder",
      });
      if (typeof path !== "string") return;
      setBusy(true);
      const result = await invoke<Project>("open_project", { path });
      setProject(result);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="rail" aria-label="ArtLog navigation">
        <div className="brand-mark" aria-label="ArtLog">
          A<span>.</span>
        </div>
        <div className="rail-bottom">
          <span className="local-dot" /> Local storage
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div className="wordmark">
            ARTLOG <span>STUDIO</span>
          </div>
          <div className="privacy">
            <span className="privacy-dot" /> YOUR FILES STAY ON THIS DEVICE
          </div>
        </header>
        {project ? (
          <div className="project-view">
            <div className="eyebrow">YOUR PROJECT</div>
            <h1>{project.name}</h1>
            <p className="project-path">{project.path}</p>
            <div className="empty-card">
              <div className="empty-icon">↟</div>
              <h2>Your history starts here</h2>
              <p>
                Checkpoint and automatic capture controls will appear when
                project storage is connected.
              </p>
              <button
                className="secondary-button"
                onClick={chooseProject}
                disabled={busy}
              >
                Open another folder
              </button>
            </div>
          </div>
        ) : (
          <div className="welcome-layout">
            <div className="welcome-copy">
              <div className="eyebrow">
                <span className="eyebrow-line" /> A SAFER SPACE TO EXPERIMENT
              </div>
              <h1>
                Your art,
                <br />
                with a <em>way back.</em>
              </h1>
              <p className="lede">
                A quiet history for the files you create. Keep painting in your
                favorite app. ArtLog keeps every saved version close at hand.
              </p>
              <button
                className="primary-button"
                onClick={chooseProject}
                disabled={busy}
              >
                <span>
                  {busy ? "Opening folder…" : "Open a project folder"}
                </span>
                <span className="arrow">↗</span>
              </button>
              {error && (
                <p className="error-message" role="alert">
                  Could not open that folder. {error}
                </p>
              )}
              <p className="compatibility">
                For Clip Studio Paint <span>·</span> Photoshop
              </p>
            </div>
            <div
              className="art-card"
              aria-label="Artwork version history illustration"
            >
              <div className="art-grid" />
              <div className="art-label">
                <span className="art-dot" /> LIVE CANVAS{" "}
                <span className="art-count">03 VERSIONS</span>
              </div>
              <div className="canvas-orbit orbit-one" />
              <div className="canvas-orbit orbit-two" />
              <div className="sun-shape" />
              <div className="mountain mountain-back" />
              <div className="mountain mountain-front" />
              <div className="canvas-stamp">
                No pressure.
                <br />
                <i>It’s all here.</i>
              </div>
              <div className="history-stack">
                <span className="history-thumb thumb-a">01</span>
                <span className="history-thumb thumb-b">02</span>
                <span className="history-thumb thumb-c">03</span>
                <span className="history-caption">
                  A little room
                  <br />
                  to try things.
                </span>
              </div>
            </div>
            <div className="welcome-foot">
              <span>ONE PROJECT · ONE HISTORY</span>
              <span>MADE FOR THE WORK IN PROGRESS</span>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
