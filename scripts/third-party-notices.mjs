#!/usr/bin/env node

/**
 * Generate the release bundle's dependency notices after npm ci and Rust toolchain setup:
 *   node scripts/third-party-notices.mjs
 *
 * Reads the resolved Cargo workspace graph and installed production npm graph.
 * Writes only THIRD_PARTY_NOTICES.txt in the repository root.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(root, "THIRD_PARTY_NOTICES.txt");
const maxNoticeBytes = 512 * 1024;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function cargoPackages() {
  const result = run("cargo", [
    "metadata",
    "--locked",
    "--format-version",
    "1",
    "--manifest-path",
    "src-tauri/Cargo.toml",
  ]);
  if (result.status !== 0) {
    throw new Error(
      `cargo metadata failed:\n${result.stderr || result.stdout}`,
    );
  }
  const metadata = JSON.parse(result.stdout);
  const nodes = new Map(
    (metadata.resolve?.nodes ?? []).map((node) => [node.id, node]),
  );
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const reachable = new Set();
  const pending = [...metadata.workspace_members];
  while (pending.length) {
    const id = pending.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const dependency of nodes.get(id)?.deps ?? [])
      pending.push(dependency.pkg);
  }
  return [...reachable]
    .map((id) => packages.get(id))
    .filter(
      (pkg) =>
        pkg && pkg.source && !metadata.workspace_members.includes(pkg.id),
    )
    .map((pkg) => ({
      ecosystem: "Cargo",
      name: pkg.name,
      version: pkg.version,
      license: pkg.license || "License expression not declared",
      directory: path.dirname(pkg.manifest_path),
      licenseFile: pkg.license_file,
      source: cargoSource(pkg),
    }));
}

function npmPackages() {
  const result =
    process.platform === "win32"
      ? run(process.env.ComSpec || "cmd.exe", [
          "/d",
          "/s",
          "/c",
          "npm.cmd",
          "ls",
          "--all",
          "--json",
          "--omit=dev",
        ])
      : run("npm", ["ls", "--all", "--json", "--omit=dev"]);
  let tree;
  try {
    tree = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `npm ls could not describe the installed production dependency graph:\n${result.stderr || result.stdout}`,
    );
  }
  const found = new Map();

  function visit(name, node, parentDirectory) {
    if (!node || node.missing || node.invalid) return;
    let directory =
      node.path || path.join(parentDirectory, "node_modules", name);
    if (!path.isAbsolute(directory)) directory = path.resolve(root, directory);
    const packageFile = path.join(directory, "package.json");
    if (!existsSync(packageFile)) return;
    try {
      directory = realpathSync(directory);
      const pkg = JSON.parse(
        readFileSync(path.join(directory, "package.json"), "utf8"),
      );
      const key = `${directory}\0${pkg.version ?? node.version ?? ""}`;
      if (!found.has(key)) {
        found.set(key, {
          ecosystem: "npm",
          name: pkg.name || name,
          version: pkg.version || node.version || "unknown",
          license: licenseDescription(pkg.license),
          directory,
        });
      }
      for (const [dependencyName, dependency] of Object.entries(
        node.dependencies ?? {},
      )) {
        visit(dependencyName, dependency, directory);
      }
    } catch (error) {
      process.stderr.write(
        `Skipping unreadable npm package ${name}: ${error.message}\n`,
      );
    }
  }

  for (const [name, dependency] of Object.entries(tree.dependencies ?? {}))
    visit(name, dependency, root);
  if (result.status !== 0 && found.size === 0) {
    throw new Error(`npm ls failed:\n${result.stderr || result.stdout}`);
  }
  return [...found.values()];
}

function licenseDescription(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) return value.map(licenseDescription).join(" OR ");
  if (value && typeof value === "object") {
    if (value.type) return String(value.type);
    if (value.url) return String(value.url);
  }
  return "License expression not declared";
}

function cargoSource(pkg) {
  if (pkg.source?.startsWith("registry+")) {
    const registry = pkg.source.slice("registry+".length);
    if (registry === "https://github.com/rust-lang/crates.io-index") {
      return `https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/download`;
    }
    return registry;
  }
  if (pkg.source?.startsWith("git+")) return pkg.source.slice("git+".length);
  return pkg.repository || "Source location not declared";
}

function candidateNoticeFiles(pkg) {
  const candidates = [];
  if (pkg.licenseFile)
    candidates.push(path.resolve(pkg.directory, pkg.licenseFile));
  let topLevel = [];
  try {
    topLevel = readdirSync(pkg.directory, { withFileTypes: true });
  } catch {
    return candidates;
  }
  for (const entry of topLevel) {
    const lower = entry.name.toLowerCase();
    const isNotice = /^(license|licence|copying|notice)(?:[._-].*)?$/.test(
      lower,
    );
    if (entry.isFile() && isNotice)
      candidates.push(path.join(pkg.directory, entry.name));
    if (entry.isDirectory() && /^(licenses?|notices?)$/i.test(entry.name)) {
      try {
        for (const nested of readdirSync(path.join(pkg.directory, entry.name), {
          withFileTypes: true,
        })) {
          if (
            nested.isFile() &&
            /^(license|licence|copying|notice)(?:[._-].*)?$/i.test(nested.name)
          ) {
            candidates.push(path.join(pkg.directory, entry.name, nested.name));
          }
        }
      } catch {
        // A package may have a protected or malformed optional notices directory.
      }
    }
  }
  return [...new Set(candidates)];
}

function readNotices(pkg) {
  return candidateNoticeFiles(pkg).flatMap((file) => {
    try {
      if (!statSync(file).isFile()) return [];
      const raw = readFileSync(file);
      const truncated = raw.length > maxNoticeBytes;
      const text = raw.subarray(0, maxNoticeBytes).toString("utf8").trim();
      if (!text) return [];
      return [
        {
          file: path.relative(pkg.directory, file).replaceAll(path.sep, "/"),
          text,
          truncated,
        },
      ];
    } catch {
      return [];
    }
  });
}

function format(packages) {
  packages.sort(
    (a, b) =>
      a.ecosystem.localeCompare(b.ecosystem) ||
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version),
  );
  const notices = new Map();
  const lines = [
    "ArtLog third-party dependency notices",
    "======================================",
    "",
    "Generated by scripts/third-party-notices.mjs from the locked Cargo workspace and installed npm production dependency graph.",
    "ArtLog itself is licensed under the MIT License. This file records third-party package license declarations and includes discovered license/notice text.",
    "",
    "Dependency declarations",
    "------------------------",
  ];
  for (const pkg of packages) {
    const files = readNotices(pkg);
    lines.push(
      `- ${pkg.ecosystem}: ${pkg.name}@${pkg.version} — ${pkg.license}`,
    );
    if (pkg.ecosystem === "Cargo")
      lines.push(`  Source archive: ${pkg.source}`);
    if (!files.length) {
      lines.push("  No license text file was found in the package directory.");
      continue;
    }
    for (const notice of files) {
      const digest = createHash("sha256").update(notice.text).digest("hex");
      const key = `${digest}:${notice.truncated}`;
      if (!notices.has(key))
        notices.set(key, { ...notice, digest, packages: [] });
      notices
        .get(key)
        .packages.push(
          `${pkg.ecosystem}: ${pkg.name}@${pkg.version} (${notice.file})`,
        );
      if (notice.truncated)
        lines.push(
          `  ${notice.file} was truncated at ${maxNoticeBytes} bytes.`,
        );
    }
  }
  lines.push("", "License and notice texts", "------------------------");
  for (const notice of notices.values()) {
    lines.push(
      "",
      `### SHA-256 ${notice.digest}`,
      "",
      `Applies to: ${notice.packages.join("; ")}`,
      "",
    );
    lines.push(notice.text);
  }
  lines.push("");
  return lines.join("\n");
}

const packages = [...cargoPackages(), ...npmPackages()];
writeFileSync(outputPath, format(packages), "utf8");
process.stdout.write(
  `Wrote ${path.relative(root, outputPath)} for ${packages.length} resolved third-party packages.\n`,
);
