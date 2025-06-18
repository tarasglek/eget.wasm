import {
  readFile,
  open,
  mkdir,
  rm,
  chmod,
  stat,
  readdir,
  rename,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { WASI } from "node:wasi";
import { randomUUID } from "node:crypto";
import { tmpdir as osTmpDir } from "node:os";
import { cwd } from "node:process";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

// We expect to find eget.wasm in the same dir as eget.js
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WASM_PATH = join(__dirname, "eget.wasm");

/**
 * Detects the current system platform and architecture as expected by eget.
 * @returns {string} System string in format 'platform/arch' (e.g., 'linux/amd64')
 */
export function detectSystem() {
  const platform =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
      ? "darwin"
      : "linux";
  const arch =
    process.arch === "x64"
      ? "amd64"
      : process.arch === "arm64"
      ? "arm64"
      : process.arch === "arm"
      ? "arm"
      : "amd64";
  return `${platform}/${arch}`;
}

/**
 * Ensures a directory exists, creating it if necessary.
 * @param {string} dirPath - Directory path to ensure
 * @throws {NodeJS.ErrnoException} If directory cannot be created
 */
async function ensureDir(dirPath) {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "EEXIST")
      throw error;
  }
}

/**
 * Converts a URL to a local file path for caching.
 * @param {string} url - The URL to convert
 * @param {string} tmpDir - The temporary directory base path
 * @returns {string} Local file path
 */
function urlToPath(url, tmpDir) {
  const urlObj = new URL(url);
  return join(
    tmpDir,
    urlObj.protocol.slice(0, -1), // Remove trailing ':'
    urlObj.host,
    urlObj.pathname
  );
}

/**
 * Parses stderr to extract useful info. eget WASM sends errors as JSON.
 * @param {string} errorStr - Error JSON string from eget WASM, or a plain error string.
 * @returns {import('./eget.d.ts').EgetError} An object containing the parsed error information.
 */
function parseEgetError(errorStr) {
  const jsonMatch = errorStr.match(/\{.*\}/s);
  if (jsonMatch) {
    try {
      const errorObj = JSON.parse(jsonMatch[0]);
      return {
        path: errorObj.path || null,
        url: errorObj.url || null,
        error: errorObj.error || "unknown error",
      };
    } catch {
      // If JSON parsing fails, fall back to the original string
    }
  }

  return {
    path: null,
    url: null,
    error: errorStr,
  };
}

/**
 * Determines if a file should be executable, based on eget's logic.
 * @param {string} fileName - Name of the file (basename only)
 * @param {number} mode - Current file mode
 * @returns {boolean} True if file should be executable
 */
function shouldBeExecutable(fileName, mode) {
  // Files that are definitely not executable
  if (
    fileName.endsWith(".deb") ||
    fileName.endsWith(".1") ||
    fileName.endsWith(".txt")
  ) {
    return false;
  }

  // Files that should be executable:
  // 1. .exe files
  // 2. .appimage files
  // 3. Files with no extension (like 'sops')
  // 4. Files that already have execute bits set
  return (
    fileName.endsWith(".exe") ||
    fileName.endsWith(".appimage") ||
    !fileName.includes(".") ||
    (mode & 0o111) !== 0
  );
}

/**
 * Fixes file permissions after WASM extraction.
 * @param {string} filePath - Path to the file
 */
async function fixExecutablePermissions(filePath) {
  if (process.platform === "win32") {
    return;
  }

  try {
    const stats = await stat(filePath);
    const fileName = basename(filePath);

    if (shouldBeExecutable(fileName, stats.mode)) {
      const currentMode = stats.mode & 0o777;
      const newMode = currentMode | 0o111; // +x
      if (currentMode !== newMode) {
        await chmod(filePath, newMode);
      }
    }
  } catch (error) {
    throw new Error(`Could not fix permissions on ${filePath}:`);
  }
}

/**
 * Node.js wrapper for eget WASM binary.
 */
export class Eget {
  /**
   * Cached promise for the compiled WASM module.
   * This ensures the module is compiled only once.
   * @type {Promise<WebAssembly.Module> | null}
   */
  static wasmCompilationPromise = null;

  /**
   * Loads and compiles the WASM module, caching the compilation promise.
   * @returns {Promise<WebAssembly.Module>} Compiled WASM module
   * @throws {Error} If WASM file cannot be loaded or compiled
   */
  async getWasmModule() {
    if (Eget.wasmCompilationPromise) {
      this.log(`Using cached WASM compilation promise`);
      return Eget.wasmCompilationPromise;
    }

    this.log(`Initiating compilation for WASM module: ${DEFAULT_WASM_PATH}`);
    Eget.wasmCompilationPromise = (async () => {
      try {
        const wasmBytes = await readFile(DEFAULT_WASM_PATH);
        const module = await WebAssembly.compile(wasmBytes);
        this.log(`Compiled WASM module: ${DEFAULT_WASM_PATH}`);
        return module;
      } catch (error) {
        // If compilation fails, reset the promise so a future call can retry.
        Eget.wasmCompilationPromise = null;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.log(
          `Failed to load/compile WASM ${DEFAULT_WASM_PATH}: ${errorMessage}`
        );
        if (errorMessage.includes("read")) {
          throw new Error(
            `Failed to read WASM file ${DEFAULT_WASM_PATH}: ${errorMessage}`
          );
        }
        throw new Error(
          `Failed to compile WASM module ${DEFAULT_WASM_PATH}: ${errorMessage}`
        );
      }
    })();
    return Eget.wasmCompilationPromise;
  }

  /**
   * Creates a new Eget instance.
   * @param {import('./eget.d.ts').EgetOptions} [options={}] - Configuration options
   */
  constructor(options = {}) {
    if (options.tmpDir && typeof options.tmpDir !== "string") {
      throw new TypeError("tmpDir must be a string");
    }
    if (options.cwd && typeof options.cwd !== "string") {
      throw new TypeError("cwd must be a string");
    }
    if (options.verbose && typeof options.verbose !== "boolean") {
      throw new TypeError("verbose must be a boolean");
    }
    if (options.onProgress && typeof options.onProgress !== "function") {
      throw new TypeError("onProgress must be a callback function");
    }

    /** @type {string} */
    this.tmpDir = resolve(options.tmpDir || "./.eget");

    /** @type {string} */
    this.cwd = resolve(
      // Prefer EGET_BIN over cwd when defined
      process.env.EGET_BIN || options.cwd || cwd()
    );

    /** @type {boolean} */
    this.verbose = options.verbose || false;

    /** @type {import('./eget.d.ts').ProgressCallback | undefined} */
    this.onProgress = options.onProgress;
  }

  /**
   * Logs a message to stderr if verbose mode is enabled.
   * @param {...any} message - Messages to log
   */
  log(...message) {
    if (this.verbose) {
      console.error("[eget.wasm]", ...message);
    }
  }

  /**
   * Downloads a file from a URL to a local path.
   * @param {string} url - URL to download from
   * @param {string} filePath - Local file path to save to
   * @param {import('./eget.d.ts').ProgressCallback | undefined} onProgress - Optional callback for progress updates.
   * @param {number | undefined} timeoutMs - The timeout (ms) to wait (defaults to 30s)
   */
  async downloadFile(url, filePath, onProgress, timeoutMs = 30_000) {
    let fileStream;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const logFn = this.log.bind(this);
    const onProgressCallback =
      typeof onProgress === "function"
        ? (
            /** @type {string} */ url,
            /** @type {number} */ currentBytes,
            /** @type {number} */ totalBytes
          ) => {
            try {
              onProgress(url, currentBytes, totalBytes);
            } catch (e) {
              const errorMessage = e instanceof Error ? e.message : String(e);
              logFn(`Error in onProgress callback: ${errorMessage}`);
            }
          }
        : () => {
            /* no-op */
          };

    try {
      this.log(`Downloading: ${url} to ${filePath}`);
      const response = await fetch(url, {
        headers: {
          "User-Agent": "eget.wasm",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      if (!response.body) {
        throw new Error("Response body is null.");
      }

      // Get the expected file size, or use -1 if unknown
      const contentLength = response.headers.get("Content-Length");
      const totalBytes = contentLength ? parseInt(contentLength, 10) : -1;

      // Indicate that the download has begun
      onProgressCallback(url, 0, totalBytes);

      // Stream the file in, calling onProgress as bytes are received
      await ensureDir(dirname(filePath));
      fileStream = createWriteStream(filePath);

      let receivedBytes = 0;
      const progressTransform = new Transform({
        transform(chunk, _encoding, callback) {
          receivedBytes += chunk.length;
          onProgressCallback(url, receivedBytes, totalBytes);
          callback(null, chunk);
        },
      });

      await pipeline(response.body, progressTransform, fileStream, {
        signal: controller.signal,
      });

      const finalTotal = totalBytes === -1 ? receivedBytes : totalBytes;
      onProgressCallback(url, receivedBytes, finalTotal);

      this.log(`Saved to: ${filePath}`);
    } catch (error) {
      // Ensure file stream is destroyed and partial file is removed
      if (fileStream && !fileStream.destroyed) {
        fileStream.destroy();
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      try {
        await rm(filePath, { force: true });
        this.log(
          `Removed partial file ${filePath} due to error: ${errorMessage}`
        );
      } catch (cleanupError) {
        // Log if stat failed (file doesn't exist) or rm failed
        if (
          /** @type {NodeJS.ErrnoException} */ (cleanupError)?.code !== "ENOENT"
        ) {
          this.log(`Failed to remove partial file ${filePath}`);
        }
      }

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new Error(`Download timed out for ${url}`);
        }
        if (error.name === "TypeError" && error.message.includes("fetch")) {
          throw new Error(`Network error downloading ${url}: ${error.message}`);
        }
        if (error.message.includes("HTTP")) {
          throw error; // Re-throw HTTP errors as-is
        }
      }
      throw new Error(`Failed to download ${url}: ${errorMessage}`);
    } finally {
      clearTimeout(timeoutId);
      // Ensure stream is closed if it exists and pipeline didn't error/finish
      if (fileStream && !fileStream.closed && !fileStream.destroyed) {
        fileStream.destroy();
      }
    }
  }

  /**
   * Runs the eget WASM binary with the given arguments.
   * @param {string[]} args - Command line arguments for eget
   * @param {object} [runOptions={}] - Options for WASI execution
   * @param {string} [runOptions.wasmSandboxDir] - the directory on the host that will be
   *  mapped to `/` in WASI (i.e., WASM's CWD for output)
   * @returns {Promise<import('./eget.d.ts').RunResult>} Result of the operation
   */
  async run(args, runOptions = {}) {
    // We need a dir to hold eget's output, which we'll map to `/` in WASI
    const { wasmSandboxDir } = runOptions;
    if (!wasmSandboxDir) {
      throw new Error("wasmSandboxDir is required");
    }
    await ensureDir(wasmSandboxDir);

    // Ensure the host temporary directory for WASM cache exists
    await ensureDir(this.tmpDir);

    // We need to capture stderr from eget
    const stderrFilePath = join(osTmpDir(), `eget.stderr_${randomUUID()}.txt`);
    const stderrFile = await open(stderrFilePath, "w");

    const wasi = new WASI({
      version: "preview1",
      args: ["eget.wasm", ...args],
      env: {
        ...process.env,
        // We always want eget.wasm to operate on `/` vs. any other --to or EGET_BIN dir
        EGET_BIN: undefined,
      },
      preopens: {
        "/": wasmSandboxDir,
        "/tmp": this.tmpDir,
      },
      stderr: stderrFile.fd,
      returnOnExit: true,
    });

    try {
      const module = await this.getWasmModule();
      const instance = await WebAssembly.instantiate(
        /** @type {WebAssembly.Module} */ (module),
        /** @type {WebAssembly.Imports} */ (wasi.getImportObject())
      );

      this.log(
        `Starting WASM execution. Sandbox: ${wasmSandboxDir}, Cache: ${this.tmpDir}`
      );
      const exitCode = wasi.start(instance);
      this.log(`WASM execution finished with exit code: ${exitCode}`);

      await stderrFile.close();

      if (exitCode === 0) {
        return { success: true };
      }

      let errorText = "";
      try {
        errorText = (
          await readFile(stderrFilePath, { encoding: "utf8" })
        ).trim();
      } catch (readError) {
        const errorMessage =
          readError instanceof Error ? readError.message : String(readError);
        this.log(`Failed to read stderr: ${errorMessage}`);
      }

      const parsedError = parseEgetError(errorText);
      this.log(`exited with code ${exitCode}: ${parsedError.error}`);
      return { success: false, ...parsedError };
    } finally {
      try {
        await stderrFile?.close();
        await rm(stderrFilePath, { force: true });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.log(`unable to remove temporary stderr file: ${errorMessage}`);
      }
    }
  }

  /**
   * Recursively moves directory contents and fixes permissions
   * @param {string} sourceDir - Source directory path
   * @param {string} destDir - Destination directory path
   */
  async moveDirectoryContents(sourceDir, destDir) {
    const items = await readdir(sourceDir);

    for (const item of items) {
      const sourcePath = join(sourceDir, item);
      const destPath = join(destDir, item);
      const stats = await stat(sourcePath);

      if (stats.isFile()) {
        await rename(sourcePath, destPath);
        await fixExecutablePermissions.call(this, destPath);
      } else if (stats.isDirectory()) {
        await ensureDir(destPath);
        await this.moveDirectoryContents(sourcePath, destPath);
      }
    }
  }

  /**
   * Downloads assets from a GitHub repository using eget.
   * @param {string} repo - GitHub repository in format 'owner/repo'
   * @param {import('./eget.d.ts').DownloadOptions} [options={}] - Download options
   * @returns {Promise<boolean>} True if download succeeded, false otherwise
   */
  async download(repo, options = {}) {
    if (!repo) {
      throw new Error("repo parameter is required");
    }

    const {
      system = detectSystem(),
      asset = null,
      tag = null,
      preRelease = false,
      all = false,
      file = null,
      to = null,
      quiet = false,
      upgrade = false,
      verify = null,
      removeArchive = false,
      extractAll = false,
      source = false,
      downloadOnly = false,
      timeout = 30000,
      onProgress = this.onProgress,
    } = options;

    // Build eget arguments
    const args = [];

    // We always run in non-interactive mode, since we aren't in a shell with user input.
    // If further user action is required, we'll error and users can try again.
    args.push("--non-interactive");

    if (tag) args.push("--tag", tag);
    if (preRelease) args.push("--pre-release");
    if (source) args.push("--source");
    if (system) args.push("--system", system);
    if (file) args.push("--file", file);
    if (all) args.push("--all");
    if (quiet) args.push("--quiet");
    if (downloadOnly) args.push("--download-only");
    if (upgrade) args.push("--upgrade-only");
    if (asset) args.push("--asset", asset);
    if (verify) args.push("--verify-sha256", verify);
    if (removeArchive) args.push("--remove-archive");
    if (extractAll) args.push("--all");
    // TODO - some others to consider adding...
    //
    // --sha256         show the SHA-256 hash of the downloaded asset
    // --rate           show GitHub API rate limiting information
    // -r, --remove     remove the given file from $EGET_BIN or the current directory
    // -D, --download-all   download all projects defined in the config file

    // HACK: due to incompatibilities between node.js and WASI's filesystem (specifically
    // how the path `.` gets handled, we don't pass any requested `--to` value through to
    // WASM, since we'll do everything in the WASI mapped `/` dir. Instead, we force all
    // operations to happen in `/` by overriding `--to`, then handle moving files in JS.
    args.push("--to", "/");

    args.push(repo);

    // Keep trying until we have all required files
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      // Use a temp dir for download, before we copy things back to cwd/to dir
      const downloadTempDir = join(
        this.tmpDir,
        `eget.download_${randomUUID()}`
      );
      await ensureDir(downloadTempDir);

      try {
        this.log(`Running eget ${args.join(" ")}`);
        const result = await this.run(args, {
          wasmSandboxDir: downloadTempDir,
        });

        if (result.success) {
          this.log("✅ eget.wasm execution succeeded!");

          const extractedItems = await readdir(downloadTempDir);
          if (extractedItems.length === 0) {
            if (upgrade) {
              this.log(
                "eget.wasm completed (upgrade-only), no new version or no files produced."
              );
            } else {
              this.log("eget.wasm completed but produced no new files.");
            }
            return true;
          }

          const toIsSubdirectory =
            to && (extractAll || (all && extractedItems.length > 1));

          for (const itemName of extractedItems) {
            const sourcePathInSandbox = join(downloadTempDir, itemName);
            const itemStats = await stat(sourcePathInSandbox);

            let finalItemPathOnHost;
            if (to) {
              if (toIsSubdirectory) {
                finalItemPathOnHost = join(this.cwd, to, itemName);
              } else {
                // 'to' is the specific name/path for the single item,
                // relative to this.cwd.
                finalItemPathOnHost = join(this.cwd, to);
              }
            } else {
              // No 'to', use original item name within this.cwd.
              finalItemPathOnHost = join(this.cwd, itemName);
            }

            await ensureDir(dirname(finalItemPathOnHost));

            if (itemStats.isFile()) {
              await rename(sourcePathInSandbox, finalItemPathOnHost);
              await fixExecutablePermissions.call(this, finalItemPathOnHost);
              this.log(`Moved ${itemName} to ${finalItemPathOnHost}`);
            } else if (itemStats.isDirectory()) {
              await ensureDir(finalItemPathOnHost);
              await this.moveDirectoryContents(
                sourcePathInSandbox,
                finalItemPathOnHost
              );
              this.log(
                `Moved directory ${itemName} contents to ${finalItemPathOnHost}`
              );
            }
          }
          return true;
        } else {
          this.log(`Attempt ${attempts + 1}: eget failed - ${result.error}`);
          if (result.url) {
            const filePathToDownload = urlToPath(result.url, this.tmpDir);
            try {
              this.log(`requesting download: ${result.url}`);
              await this.downloadFile(
                result.url,
                filePathToDownload,
                onProgress,
                timeout
              );
              attempts++;
            } catch (downloadError) {
              const errorMessage =
                downloadError instanceof Error
                  ? downloadError.message
                  : String(downloadError);
              this.log(`Download failed for ${result.url}: ${errorMessage}`);
              return false;
            }
          } else {
            this.log(
              `eget failed with no recovery URL. Error: ${result.error}`
            );
            return false;
          }
        }
      } finally {
        try {
          await rm(downloadTempDir, { recursive: true, force: true });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          this.log(`Could not clean up download temp dir: ${errorMessage}`);
        }
      }
    }

    this.log(
      `Max attempts (${maxAttempts}) reached. Download failed for ${repo}.`
    );
    return false;
  }

  /**
   * Cleans up temporary files created during downloads.
   * @returns {Promise<void>}
   */
  async cleanup() {
    try {
      await stat(this.tmpDir);
      await rm(this.tmpDir, { recursive: true, force: true });
      this.log(`Cleaned up temporary files in ${this.tmpDir}`);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "ENOENT") {
        this.log(
          `Temporary directory ${this.tmpDir} not found, no cleanup needed.`
        );
      } else {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.warn(
          `Could not clean up temporary files in ${this.tmpDir}:`,
          errorMessage
        );
      }
    }
  }
}

/**
 * Convenience function to download a GitHub repository release with automatic cleanup.
 * Creates an Eget instance, downloads the specified repository, and cleans up temporary files.
 *
 * @param {string} repo - GitHub repository in format 'owner/repo'
 * @param {import('./eget.d.ts').EgetFunctionOptions} [options={}] - Combined download and eget options
 * @returns {Promise<boolean>} True if download succeeded, false otherwise
 *
 * @example
 * // Download sops for current platform to current dir
 * await eget('getsops/sops');
 *
 * @example
 * // Download specific version with options
 * await eget('cli/cli', {
 *   system: 'linux/amd64',
 *   tag: 'v2.40.1',
 *   to: './bin/custom-name',
 *   verbose: true
 * });
 *
 * @example
 * // Download with asset filtering, put in different directory
 * await eget('goreleaser/goreleaser', {
 *   asset: '^json',  // Exclude JSON files
 *   all: true,
 *   cwd: '/usr/local/eget_downloads'
 * });
 */
export async function eget(repo, options = {}) {
  // Separate eget constructor options from download options
  const { cwd, tmpDir, verbose, skipCleanup, onProgress, ...downloadOptions } =
    options;
  const egetInstance = new Eget({ cwd, tmpDir, verbose, onProgress });

  try {
    return await egetInstance.download(repo, downloadOptions);
  } finally {
    if (!skipCleanup) {
      await egetInstance.cleanup();
    }
  }
}
