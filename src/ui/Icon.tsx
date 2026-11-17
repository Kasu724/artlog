const paths = {
  brand: "M2 9l9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M2 19l9 5 9-5",
  folder: "M3 19V5h7l2 3h9v11H3Z",
  history: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2",
  settings:
    "M10 3h4l.6 2.4 1.5.9 2.4-.7 2 3.5-1.8 1.7v1.8l1.8 1.7-2 3.5-2.4-.7-1.5.9-.6 2.4h-4l-.6-2.4-1.5-.9-2.4.7-2-3.5 1.8-1.7v-1.8L3.5 9l2-3.5 2.4.7 1.5-.9L10 3Zm5 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  file: "M5 3h9l5 5v13H5V3Zm9 0v5h5",
  device: "M4 4h16v12H4V4ZM2 20h20",
  check: "m5 12 4 4L19 6",
  pause: "M9 5v14m6-14v14",
  chevron: "m6 9 6 6 6-6",
  warning: "M12 3 2 20h20L12 3Zm0 6v4m0 3v.1",
} as const;

export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      className={`icon icon-${name}`}
      viewBox={name === "brand" ? "0 0 26 27" : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
      {name === "brand" && (
        <path
          className="brand-spark"
          d="M22 1c0 2.4 1.2 3.6 3.5 3.6-2.3 0-3.5 1.2-3.5 3.6 0-2.4-1.2-3.6-3.5-3.6C20.8 4.6 22 3.4 22 1Z"
        />
      )}
    </svg>
  );
}
