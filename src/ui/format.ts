export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

export function formatDate(value: string): {
  day: string;
  time: string;
  full: string;
} {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    return { day: value, time: "", full: value };
  return {
    day: new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date),
    time: new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date),
    full: date.toLocaleString(),
  };
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

export function isClipFile(path: string): boolean {
  const name = fileName(path);
  return name.length > 5 && name.toLowerCase().endsWith(".clip");
}
