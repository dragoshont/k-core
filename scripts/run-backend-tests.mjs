import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function postgresBin() {
  for (const directory of [
    process.env.POSTGRES_BIN,
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@16/bin",
  ]) {
    if (directory && existsSync(join(directory, "initdb")) && existsSync(join(directory, "pg_ctl"))) {
      return directory;
    }
  }
  return null;
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a PostgreSQL test port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function run(command, args) {
  return execFileAsync(command, args, { encoding: "utf8" });
}

function runVitest(args, env) {
  const executable = resolve("node_modules/.bin/vitest");
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, ["run", "--config", "vitest.backend.config.ts", ...args], {
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Vitest terminated by ${signal}`));
      else resolveRun(code ?? 1);
    });
  });
}

async function availableDockerImage() {
  for (const image of [
    "postgres:16-alpine",
    "public.ecr.aws/docker/library/postgres:16-alpine",
  ]) {
    try {
      await run("docker", ["image", "inspect", image]);
      return image;
    } catch {
      // Try the next official local tag before falling back to native PostgreSQL.
    }
  }
  return null;
}

async function runWithDocker(image) {
  const name = `k-phase2-postgres-${Date.now()}`;
  const port = await availablePort();
  await run("docker", [
    "run", "--rm", "-d", "--name", name,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e", "POSTGRES_USER=postgres",
    "-p", `127.0.0.1:${port}:5432`,
    "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=256m",
    image,
  ]);
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await run("docker", ["exec", name, "pg_isready", "-U", "postgres", "-d", "postgres"]);
        return await runVitest(process.argv.slice(2), {
          ...process.env,
          K_TEST_POSTGRES_ADMIN_URL: `postgres://postgres@127.0.0.1:${port}/postgres`,
        });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error("Docker PostgreSQL test server did not become ready");
  } finally {
    await run("docker", ["rm", "-f", name]).catch(() => undefined);
  }
}

async function runWithNative(binaryDirectory) {
  const root = await mkdtemp(join(tmpdir(), "k-phase2-test-server-"));
  const dataDirectory = join(root, "data");
  const socketDirectory = join(root, "socket");
  const logPath = join(root, "postgres.log");
  const port = await availablePort();
  await mkdir(socketDirectory, { recursive: true });
  let started = false;
  try {
    await run(join(binaryDirectory, "initdb"), [
      "-D", dataDirectory, "--auth=trust", "--no-locale", "--no-sync",
      "--set", "shared_memory_type=mmap", "--set", "dynamic_shared_memory_type=posix",
      "--set", "shared_buffers=16MB", "--set", "max_connections=20",
      "-E", "UTF8", "-U", "postgres",
    ]);
    await run(join(binaryDirectory, "pg_ctl"), [
      "-D", dataDirectory, "-l", logPath,
      "-o", `-F -h 127.0.0.1 -p ${port} -k ${socketDirectory}`, "-w", "start",
    ]);
    started = true;
    return await runVitest(process.argv.slice(2), {
      ...process.env,
      K_TEST_POSTGRES_ADMIN_URL: `postgres://postgres@127.0.0.1:${port}/postgres`,
      POSTGRES_BIN: binaryDirectory,
    });
  } finally {
    if (started) await run(join(binaryDirectory, "pg_ctl"), ["-D", dataDirectory, "-m", "immediate", "-w", "stop"]).catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
}

try {
  if (process.env.K_TEST_POSTGRES_ADMIN_URL) {
    process.exitCode = await runVitest(process.argv.slice(2), process.env);
  } else {
    const dockerImage = await availableDockerImage();
    if (dockerImage) {
      process.exitCode = await runWithDocker(dockerImage);
    } else {
      const binaryDirectory = postgresBin();
      if (!binaryDirectory) throw new Error("PostgreSQL 16 tests require K_TEST_POSTGRES_ADMIN_URL, an existing official PostgreSQL 16 Alpine image, or postgresql@16.");
      process.exitCode = await runWithNative(binaryDirectory);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
