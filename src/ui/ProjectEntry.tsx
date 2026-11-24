import { useId } from "react";
import type { RecentProject } from "./recent-projects";
import "./project-entry.css";

export function Welcome({
  busy,
  error,
  notice,
  onChooseClip,
}: {
  busy: boolean;
  error: string;
  notice: string;
  onChooseClip: () => void;
}) {
  return (
    <section className="welcome-layout">
      <h1>ArtLog</h1>
      <button
        className="primary-button welcome-action"
        onClick={onChooseClip}
        disabled={busy}
      >
        Open a .clip file
      </button>
      {notice && (
        <p className="welcome-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-message welcome-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function RecentProjects({
  projects,
  busy,
  onOpen,
}: {
  projects: RecentProject[];
  busy: boolean;
  onOpen: (item: RecentProject) => void;
}) {
  const locationId = useId();
  return (
    <section
      className="recent-projects"
      aria-labelledby="recent-projects-title"
    >
      <h2 id="recent-projects-title">Recently opened</h2>
      {projects.length ? (
        <ul>
          {projects.map((item, index) => (
            <li key={`${item.root}\0${item.id}`}>
              <button
                type="button"
                className="secondary-button recent-project-button"
                disabled={busy}
                onClick={() => onOpen(item)}
                title={`${item.name}\n${item.root}`}
                aria-label={item.name}
                aria-describedby={`${locationId}-${index}`}
              >
                <bdi>{item.name}</bdi>
                <bdi
                  className="recent-project-location"
                  id={`${locationId}-${index}`}
                >
                  {item.root}
                </bdi>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="recent-projects-empty">
          Projects you open will appear here.
        </p>
      )}
    </section>
  );
}
