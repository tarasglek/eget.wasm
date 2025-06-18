/**
 * Callback function for download progress updates.
 * @param url - The URL being downloaded.
 * @param currentBytes - The number of bytes downloaded so far.
 * @param totalBytes - The total number of bytes to download.
 *   Can be -1 if the total size is unknown.
 */
export type ProgressCallback = (
  url: string,
  currentBytes: number,
  totalBytes: number
) => void;

/**
 * Configuration options for creating a new Eget instance.
 */
export interface EgetOptions {
  /** Host's working directory for final output (defaults to `process.cwd()`). */
  cwd?: string;
  /** Temporary directory for downloaded files (defaults to `./.eget`). */
  tmpDir?: string;
  /** Optional callback for download progress updates. */
  onProgress?: ProgressCallback;
  /** Enable verbose logging, useful for debugging eget.wasm. */
  verbose?: boolean;
}

/**
 * Represents a parsed error from the eget WASM binary.
 */
export interface EgetError {
  /** The file path associated with the error, if available. */
  path: string | null;
  /** The URL associated with the error, if available. */
  url: string | null;
  /** The error message. */
  error: string;
}

/**
 * Options for the `eget.download()` method.
 */
export interface DownloadOptions {
  /** Target system (e.g., 'linux/amd64'). Auto-detected if not provided. */
  system?: string;
  /** Asset name pattern to match. */
  asset?: string;
  /** Specific release tag. */
  tag?: string;
  /** Include pre-release versions. */
  preRelease?: boolean;
  /** Download all assets. */
  all?: boolean;
  /** Extract specific file from archive. */
  file?: string;
  /**
   * Path relative to the Eget instance's `cwd`.
   * If a single asset results, 'to' is its target path.
   * If multiple assets or `all` is included, 'to' is a subdirectory.
   */
  to?: string;
  /** Only upgrade if newer version available. */
  upgradeOnly?: boolean;
  /** Remove archive after extraction. */
  removeArchive?: boolean;
  /** Extract all files from archive. */
  extractAll?: boolean;
  /** Download the source code for the target repo instead of a release. */
  source?: boolean;
  /** Stop after downloading the asset (no extraction). */
  downloadOnly?: boolean;
  /** Timeout (ms) for downloads. */
  timeout?: number;
  /** Optional callback for download progress updates. */
  onProgress?: ProgressCallback;
}

/**
 * The result of a `eget.run()` operation.
 */
export interface RunResult {
  /** Whether the operation succeeded. */
  success: boolean;
  /** URL that needs to be downloaded (if success is false). */
  url?: string | null;
  /** Path associated with the error. */
  path?: string | null;
  /** Error message. */
  error?: string;
}

/**
 * Options for the `eget()` convenience function.
 * Combines EgetOptions and DownloadOptions with an extra `skipCleanup` flag.
 */
export type EgetFunctionOptions = EgetOptions &
  DownloadOptions & {
    /** Whether to skip automatic cleanup of temp files (for debugging). */
    skipCleanup?: boolean;
  };

/**
 * Eget class.
 */
export interface Eget {
  tmpDir: string;
  cwd: string;
  verbose: boolean;
  onProgress: ProgressCallback | undefined;

  getWasmModule(): Promise<WebAssembly.Module>;
  log(message: string): void;
  ensureDir(dirPath: string): Promise<void>;
  downloadFile(
    url: string,
    filePath: string,
    onProgress: ProgressCallback | undefined,
    timeoutMs?: number
  ): Promise<void>;
  run(
    args: string[],
    runOptions: { wasmSandboxDir?: string }
  ): Promise<RunResult>;
  moveDirectoryContents(sourceDir: string, destDir: string): Promise<void>;
  download(repo: string, options?: DownloadOptions): Promise<boolean>;
  cleanup(): Promise<void>;
}
