import { readFile, writeFile, open, mkdir, rm, chmod, stat, readdir } from "node:fs/promises";
import { dirname, join, extname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { WASI } from "node:wasi";
import { randomUUID } from "node:crypto";
import { tmpdir as osTmpDir } from "node:os";

// We expect to find eget.wasm in the same dir as eget.js
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WASM_PATH = join(__dirname, "eget.wasm");

/**
 * @typedef {Object} EgetOptions
 * @property {string} [tmpDir='./tmp'] - Temporary directory for downloaded files
 * @property {boolean} [verbose=false] - Enable verbose logging
 */

/**
 * @typedef {object} EgetError
 * @property {string|null} path - The file path associated with the error, if available.
 * @property {string|null} url - The URL associated with the error, if available.
 * @property {string} error - The error message. Defaults to "unknown error"
 *   if the original error string is valid JSON but lacks an error field,
 *   or the original error string if it's not valid JSON.
 */

/**
 * @typedef {Object} DownloadOptions
 * @property {string} [system] - Target system (e.g., 'linux/amd64'). Auto-detected if not provided
 * @property {string} [asset] - Asset name pattern to match
 * @property {string} [output='.'] - Output directory
 * @property {string} [tag] - Specific release tag
 * @property {boolean} [preRelease=false] - Include pre-release versions
 * @property {boolean} [all=false] - Download all assets
 * @property {string} [file] - Extract specific file from archive
 * @property {string} [to] - Rename extracted file
 * @property {boolean} [quiet=false] - Suppress output
 * @property {boolean} [upgrade=false] - Only upgrade if newer version available
 * @property {string} [verify] - SHA256 hash to verify download
 * @property {boolean} [removeArchive=false] - Remove archive after extraction
 * @property {boolean} [extractAll=false] - Extract all files from archive
 * @property {number} [timeout=30000] - Timeout (ms) for downloads
 */

/**
 * @typedef {Object} RunResult
 * @property {boolean} success - Whether the operation succeeded
 * @property {string|null} [url] - URL that needs to be downloaded (if success is false)
 * @property {string|null} [path] - Path associated with the error
 * @property {string} [error] - Error message
 */

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
 * @returns {EgetError} An object containing the parsed error information.
 */
function parseEgetError(errorStr) {
  try {
    const errorObj = JSON.parse(errorStr);
    return {
      path: errorObj.path || null,
      url: errorObj.url || null,
      error: errorObj.error || "unknown error"
    };
  } catch {
    return {
      path: null,
      url: null,
      error: errorStr
    }
  }
}

/**
 * Determines if a file should be made executable based on its characteristics.
 * @param {string} filePath - Path to the file
 * @param {import('fs').Stats} stats - File stats
 * @returns {Promise<boolean>} True if file should be executable
 */
async function isExecutableFile(filePath, stats) {
  if (!stats.isFile()) {
    return false;
  }

  const ext = extname(filePath).toLowerCase();
  // Skip files with extensions that are clearly not executables
  const nonExecutableExts = [
    ".txt",
    ".md",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".tar",
    ".gz",
    ".zip",
    ".7z",
    ".rar",
    ".bz2",
    ".xz",
    ".pdf",
    ".doc",
    ".docx",
    ".html",
    ".css",
    ".js",
    ".ts",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".log",
    ".conf",
    ".cfg",
    ".ini",
    ".properties",
  ];

  if (nonExecutableExts.includes(ext)) {
    return false;
  }

  // If no extension, check if it might be a binary by reading the first few bytes
  if (!ext) {
    try {
      const buffer = await readFile(filePath, { encoding: null, flag: "r" });
      const firstBytes = buffer.subarray(0, 4);

      // Check for common executable signatures, ELF magic number (Linux/Unix binaries)
      if (
        firstBytes[0] === 0x7f &&
        firstBytes[1] === 0x45 &&
        firstBytes[2] === 0x4c &&
        firstBytes[3] === 0x46
      ) {
        return true;
      }

      // Mach-O magic numbers (macOS binaries)
      const magic = firstBytes.readUInt32BE(0);
      if (
        magic === 0xfeedface ||
        magic === 0xfeedfacf ||
        magic === 0xcefaedfe ||
        magic === 0xcffaedfe
      ) {
        return true;
      }
    } catch (error) {
      return false;
    }
  }

  return false;
}

/**
 * Sets executable permissions on downloaded files for Unix-like systems.
 * @param {string} filePath - Path to the file to make executable
 */
async function setExecutablePermissions(filePath) {
  if (process.platform === "win32") {
    return; // no Unix permissions on Windows
  }

  try {
    const stats = await stat(filePath);
    const shouldBeExecutable = await isExecutableFile(filePath, stats);
    if (shouldBeExecutable) {
      await chmod(filePath, 0o755);
    }
  } catch (error) {
    console.warn(
      `Could not set executable permissions on ${filePath}:`,
      error.message
    );
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
   * Creates a new Eget instance.
   * @param {EgetOptions} [options={}] - Configuration options
   */
  constructor(options = {}) {
    if (options.tmpDir && typeof options.tmpDir !== "string") {
      throw new TypeError("tmpDir must be a string");
    }
    if (options.verbose && typeof options.verbose !== "boolean") {
      throw new TypeError("verbose must be a boolean");
    }

    /** @type {string} */
    this.tmpDir = resolve(options.tmpDir || "./tmp");

    /** @type {boolean} */
    this.verbose = options.verbose || false;
  }

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
        this.log(
          `Failed to load/compile WASM ${DEFAULT_WASM_PATH}: ${error.message}`
        );
        if (error.message.includes("read")) {
            throw new Error(
              `Failed to read WASM file ${DEFAULT_WASM_PATH}: ${error.message}`
            );
        }
        throw new Error(
          `Failed to compile WASM module ${DEFAULT_WASM_PATH}: ${error.message}`
        );
      }
    })();
    return Eget.wasmCompilationPromise;
  }

  /**
   * Logs a message to stderr if verbose mode is enabled.
   * @param {string} message - Message to log
   */
  log(message) {
    if (this.verbose) {
      console.error(`[eget.wasm] ${message}`);
    }
  }

  /**
   * Ensures a directory exists, creating it if necessary.
   * @param {string} dirPath - Directory path to ensure
   * @throws {Error} If directory cannot be created
   */
  async ensureDir(dirPath) {
    try {
      await mkdir(dirPath, { recursive: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }

  /**
   * Downloads a file from a URL to a local path.
   * @param {string} url - URL to download from
   * @param {string} filePath - Local file path to save to
   * @param {number} timeout - The timeout (ms) to wait (defaults to 30s)
   * @throws {Error} If download fails or network error occurs
   */
  async downloadFile(url, filePath, timeoutMs = 30000) {
    this.log(`Downloading: ${url} to ${filePath}`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      await this.ensureDir(dirname(filePath));
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await writeFile(filePath, buffer);
      this.log(`Saved to: ${filePath}`);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
         throw new Error(`Download timed out for ${url}`);
      }
      if (error.name === "TypeError" && error.message.includes("fetch")) {
        throw new Error(`Network error downloading ${url}: ${error.message}`);
      }
      if (error.message.includes("HTTP")) {
        throw error; // Re-throw HTTP errors as-is
      }
      throw new Error(`Failed to download ${url}: ${error.message}`);
    }
  }

  /**
   * Runs the eget WASM binary with the given arguments.
   * @param {string[]} args - Command line arguments for eget
   * @param {object} [runOptions={}] - Options for WASI execution
   * @param {string} [runOptions.cwd] - CWD for the WASM instance
   * @returns {Promise<RunResult>} Result of the operation
   */
  async run(args, runOptions = {}) {
    // We need to capture stderr from eget
    const stderrFilePath = join(osTmpDir(), `eget.stderr_${randomUUID()}.txt`);
    const stderrFile = await open(stderrFilePath, 'w');
    this.log(`using stderr file ${stderrFilePath}`);

    // Ensure the host temporary directory for WASM cache exists
    await this.ensureDir(this.tmpDir);    

    // Ensure WASM's CWD exists
    const wasmCwd = resolve(runOptions.cwd || process.cwd());
    await this.ensureDir(wasmCwd);

    const wasi = new WASI({
      version: "preview1",
      args: ["eget.wasm", ...args],
      env: process.env,
      preopens: {
        "/": wasmCwd,
        "/tmp": this.tmpDir,
      },
      stderr: stderrFile.fd,
      returnOnExit: true 
    });

    try {
      const module = await this.getWasmModule();
      const instance = await WebAssembly.instantiate(
        module,
        wasi.getImportObject()
      );

      this.log(`Starting WASM execution...`);
      const exitCode = wasi.start(instance);
      this.log(`WASM execution finished with exit code: ${exitCode}`);

      await stderrFile.close();

      if(exitCode === 0) {
        return { success: true };
      }

      let errorText = "";
      try {
        errorText = (await readFile(stderrFilePath, { encoding: 'utf8' })).trim();
      } catch (readError) {
        this.log(`Failed to read stderr: ${readError.message}`);
      }

      const parsedError = parseEgetError(errorText);
      this.log(`exited with code ${exitCode}: ${parsedError.error}`);
      return { success: false, ...parsedError };
    } finally {
      try {
        await stderrFile?.close();
        await rm(stderrFilePath, { force: true });        
      } catch(error) {
        this.log(`unable to remove temporary stderr file: ${error.message}`);
      }
    }
  }

  /**
   * Downloads assets from a GitHub repository using eget.
   * @param {string} repo - GitHub repository in format 'owner/repo'
   * @param {DownloadOptions} [options={}] - Download options
   * @returns {Promise<boolean>} True if download succeeded, false otherwise
   * @throws {Error} If repo is not provided or download fails after max attempts
   */
  async download(repo, options = {}) {
    if (!repo) {
      throw new Error("repo parameter is required");
    }

    const {
      system = detectSystem(),
      asset = null,
      output = ".",
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
      timeout = 30000
    } = options;

    // Build eget arguments
    const args = [];

    args.push("--non-interactive");

    if (tag) args.push("--tag", tag);
    if (preRelease) args.push("--pre-release");
    // --source - download the source code for the target repo instead of a release
    // `to` is relative to WASM's CWD, which will be `effectiveOutputPath`
    if (to) args.push("--to", to);
    if (system) args.push("--system", system);
    if (file) args.push("--file", file);
    if (all) args.push("--all");
    if (quiet) args.push("--quiet");
    // -d, --download-only  stop after downloading the asset (no extraction)
    if (upgrade) args.push("--upgrade-only");
    if (asset) args.push("--asset", asset);
    // --sha256         show the SHA-256 hash of the downloaded asset
    // --rate           show GitHub API rate limiting information
    // -r, --remove     remove the given file from $EGET_BIN or the current directory
    if (verify) args.push("--verify-sha256", verify);
    if (removeArchive) args.push("--remove-archive");
    if (extractAll) args.push("--extract-all");
    // -D, --download-all   download all projects defined in the config file
    // TODO: there is no --output flag...
    //if (output !== ".") args.push("--output", output);

    args.push(repo);

    this.log(`Running eget with args: ${args.join(" ")}`);

    const effectiveOutputPath = resolve(output);

    // Keep trying until we have all required files
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const result = await this.run(args, { cwd: effectiveOutputPath });

      if (result.success) {
        this.log("✅ Download completed successfully!");

        // Files are in `effectiveOutputPath` or `to` (relative to it)
        let filesToChmod = [];
        if (file && to) {
          filesToChmod.push(resolve(effectiveOutputPath, to));
        } else if (file) {
          // Extracted file name is basename of the `file` pattern
          const fileName = basename(file);
          filesToChmod.push(resolve(effectiveOutputPath, fileName));
        } else { // All files from archive, or a single downloaded asset
          try {
            const dirContents = await readdir(effectiveOutputPath);
            for (const fName of dirContents) {
              filesToChmod.push(join(effectiveOutputPath, fName));
            }
          } catch (e) {
            this.log(`Warn: readdir ${effectiveOutputPath} for perms: ${e.message}`);
          }
        }
        for (const fPath of filesToChmod) {
          await setExecutablePermissions(fPath);
        }
        return true;
      } else {
        this.log(`Attempt ${attempts + 1}: eget failed - ${result.error}`);
        if (result.url) {
          const filePathToDownload = urlToPath(result.url, this.tmpDir);
          try {
            await this.downloadFile(result.url, filePathToDownload, timeout);
            attempts++;
          } catch (downloadError) {
            this.log(`Download failed for ${result.url}: ${downloadError.message}`);
            return false;
          }
        } else {
          this.log(`eget failed with no recovery URL. Error: ${result.error}`);
          return false;
        }
      }
    }

    this.log(`Max attempts (${maxAttempts}) reached. Download failed for ${repo}.`);
    return false;
  }

  /**
   * Cleans up temporary files created during downloads.
   * @returns {Promise<void>}
   */
  async cleanup() {
    try {
      await stat(this.tmpDir); // Check existence before rm
      await rm(this.tmpDir, { recursive: true, force: true });
      this.log(`Cleaned up temporary files in ${this.tmpDir}`);
    } catch (error) {
      if (error.code === "ENOENT") {
        this.log(`Temporary directory ${this.tmpDir} not found, no cleanup needed.`);
      } else {
        console.warn(`Could not clean up temporary files in ${this.tmpDir}:`, error.message);
      }
    }
  }
}

/**
 * Convenience function to download a GitHub repository release with automatic cleanup.
 * Creates an Eget instance, downloads the specified repository, and cleans up temporary files.
 *
 * @param {string} repo - GitHub repository in format 'owner/repo'
 * @param {DownloadOptions & EgetOptions} [options={}] - Combined download and eget options
 * @param {string} [options.tmpDir='./tmp'] - Temporary directory for downloads
 * @param {boolean} [options.verbose=false] - Enable verbose logging
 * @returns {Promise<boolean>} True if download succeeded, false otherwise
 * @throws {Error} If repo is not provided or download fails
 *
 * @example
 * // Download sops for current platform
 * await eget('getsops/sops');
 *
 * @example
 * // Download specific version with options
 * await eget('cli/cli', {
 *   system: 'linux/amd64',
 *   tag: 'v2.40.1',
 *   output: './bin',
 *   verbose: true
 * });
 *
 * @example
 * // Download with asset filtering
 * await eget('goreleaser/goreleaser', {
 *   asset: '^json',  // Exclude JSON files
 *   all: true
 * });
 */
export async function eget(repo, options = {}) {
  // Separate eget constructor options from download options
  const { tmpDir, verbose, ...downloadOptions } = options;
  const egetInstance = new Eget({ tmpDir, verbose });

  try {
    return await egetInstance.download(repo, downloadOptions);
  } finally {
    await egetInstance.cleanup();
  }
}
