import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WASI } from "node:wasi";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {Object} EgetOptions
 * @property {string} [wasmPath="./eget.wasm"] - Path to the eget.wasm file
 * @property {string} [tmpDir='./tmp'] - Temporary directory for downloaded files
 * @property {boolean} [verbose=false] - Enable verbose logging
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
 */

/**
 * @typedef {Object} RunResult
 * @property {boolean} success - Whether the operation succeeded
 * @property {string} [missingUrl] - URL that needs to be downloaded (if success is false)
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
 * Parses an error string to extract a missing URL.
 * @param {string} errorStr - Error string from eget WASM
 * @returns {string|null} Extracted URL or null if not found
 */
function parseErrorForUrl(errorStr) {
  // Parse the JSON error message from eget WASM
  const match = errorStr.match(/"url":"([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * Node.js wrapper for eget WASM binary.
 */
export class Eget {
  /**
   * Creates a new Eget instance.
   * @param {EgetOptions} [options={}] - Configuration options
   * @throws {Error} If wasmPath is not provided
   */
  constructor(options = {}) {
    if (options.wasmPath && typeof options.wasmPath !== 'string') {
      throw new TypeError('wasmPath must be a string');
    }
    if (options.tmpDir && typeof options.tmpDir !== 'string') {
      throw new TypeError('tmpDir must be a string');
    }
    if (options.verbose && typeof options.verbose !== 'boolean') {
      throw new TypeError('verbose must be a boolean');
    }

    /** @type {string} */
    this.wasmPath = options.wasmPath ?? join(__dirname, "eget.wasm");

    /** @type {string} */
    this.tmpDir = options.tmpDir || "./tmp";

    /** @type {boolean} */
    this.verbose = options.verbose || false;
  }

  /**
   * Logs a message if verbose mode is enabled.
   * @param {string} message - Message to log
   */
  log(message) {
    if (this.verbose) {
      console.log(message);
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
   * @throws {Error} If download fails or network error occurs
   */
  async downloadFile(url, filePath) {
    this.log(`Downloading: ${url}`);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      await this.ensureDir(dirname(filePath));
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await writeFile(filePath, buffer);
      this.log(`Saved to: ${filePath}`);
    } catch (error) {
      if (error.name === "TypeError" && error.message.includes("fetch")) {
        throw new Error(`Network error downloading ${url}: ${error.message}`);
      }
      if (error.message.includes('HTTP')) {
        throw error; // Re-throw HTTP errors as-is
      }
      throw new Error(`Failed to download ${url}: ${error.message}`);
    }
  }

  /**
   * Runs the eget WASM binary with the given arguments.
   * @param {string[]} args - Command line arguments for eget
   * @returns {Promise<RunResult>} Result of the operation
   * @throws {Error} If WASM file cannot be loaded or unexpected error occurs
   */
  async run(args) {
    let wasmBytes;
    try {
      wasmBytes = await readFile(this.wasmPath);
    } catch (error) {
      throw new Error(
        `Failed to read WASM file ${this.wasmPath}: ${error.message}`
      );
    }

    const wasi = new WASI({
      version: "preview1",
      args: ["eget.wasm", ...args],
      env: process.env,
      preopens: {
        "/": process.cwd(),
      },
    });

    let module, instance;
    try {
      module = await WebAssembly.compile(wasmBytes);
      instance = await WebAssembly.instantiate(module, wasi.getImportObject());

      wasi.start(instance);
      return { success: true };
    } catch (error) {
      const missingUrl = parseErrorForUrl(error.toString());
      if (missingUrl) {
        return { success: false, missingUrl };
      }
      throw error;
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
    } = options;

    // Build eget arguments
    const args = [];

    if (system) args.push("--system", system);
    if (asset) args.push("--asset", asset);
    if (output !== ".") args.push("--output", output);
    if (tag) args.push("--tag", tag);
    if (preRelease) args.push("--pre-release");
    if (all) args.push("--all");
    if (file) args.push("--file", file);
    if (to) args.push("--to", to);
    if (quiet) args.push("--quiet");
    if (upgrade) args.push("--upgrade-only");
    if (verify) args.push("--verify-sha256", verify);
    if (removeArchive) args.push("--remove-archive");
    if (extractAll) args.push("--extract-all");

    args.push(repo);

    this.log(`Running eget with args: ${args.join(" ")}`);

    // Keep trying until we have all required files
    let attempts = 0;
    const maxAttempts = 10; // Prevent infinite loops

    while (attempts < maxAttempts) {
      const result = await this.run(args);

      if (result.success) {
        this.log("✅ Download completed successfully!");
        return true;
      }

      if (result.missingUrl) {
        this.log(`Missing file for URL: ${result.missingUrl}`);
        const filePath = urlToPath(result.missingUrl, this.tmpDir);
        await this.downloadFile(result.missingUrl, filePath);
        attempts++;
      } else {
        throw new Error("Unexpected error from eget WASM");
      }
    }

    throw new Error(`Max attempts (${maxAttempts}) reached. Download failed.`);
  }

  /**
   * Cleans up temporary files created during downloads.
   * @returns {Promise<void>}
   */
  async cleanup() {
    try {
      await rm(this.tmpDir, { recursive: true, force: true });
      this.log("Cleaned up temporary files");
    } catch (error) {
      console.warn("Could not clean up temporary files:", error.message);
    }
  }
}

/**
 * Convenience function to download a GitHub repository release with automatic cleanup.
 * Creates an Eget instance, downloads the specified repository, and cleans up temporary files.
 *
 * @param {string} repo - GitHub repository in format 'owner/repo'
 * @param {DownloadOptions & EgetOptions} [options={}] - Combined download and eget options
 * @param {string} [options.wasmPath] - Path to eget.wasm file (defaults to bundled version)
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
  const { wasmPath, tmpDir, verbose, ...downloadOptions } = options;
  const egetInstance = new Eget({ tmpDir, verbose, wasmPath });

  try {
    return await egetInstance.download(repo, downloadOptions);
  } finally {
    // Always clean up, even if download fails
    await egetInstance.cleanup();
  }
}
