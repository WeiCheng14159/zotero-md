import { getPref, setPref } from "../utils/prefs";

/**
 * Gets the user's home directory via XPCOM directory service.
 */
function getHomeDir(): string {
  return Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
}

/**
 * Auto-detects the python3 binary path.
 * Checks virtualenvs, homebrew, and system paths.
 * Saves the found path to preferences.
 */
export function detectPython(): string | null {
  const configured = getPref("pythonPath");
  if (configured && fileExists(configured)) return configured;

  const homedir = getHomeDir();
  const candidates: string[] = [];

  // Scan virtualenvs
  try {
    const venvsDir = `${homedir}/.virtualenvs`;
    const dirFile = Zotero.File.pathToFile(venvsDir);
    if (dirFile.exists() && dirFile.isDirectory()) {
      const entries = dirFile.directoryEntries;
      while (entries?.hasMoreElements()) {
        // @ts-expect-error nsIFile enumeration not fully typed
        const entry = entries.getNext()?.QueryInterface(
          Components.interfaces.nsIFile,
        );
        if (entry?.isDirectory()) {
          candidates.push(`${entry.path}/bin/python3`);
        }
      }
    }
  } catch {
    // ignore
  }

  candidates.push(
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
  );

  for (const path of candidates) {
    if (fileExists(path)) {
      setPref("pythonPath", path);
      ztoolkit.log(`[AutoMD] Auto-detected python3 at: ${path}`);
      return path;
    }
  }

  return null;
}

/**
 * Verifies that the selected converter engine is importable by the detected Python.
 * Returns true if the engine can be imported, false otherwise.
 */
export async function verifyEngine(
  pythonPath: string,
  engine: string,
): Promise<boolean> {
  const importCheck =
    engine === "docling"
      ? "from docling.document_converter import DocumentConverter"
      : "import pymupdf4llm";

  try {
    await spawnProcess("/bin/sh", [
      "-c",
      `${pythonPath} -c "${importCheck}" 2>/dev/null`,
    ]);
    return true;
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    const file = Zotero.File.pathToFile(path);
    return file.exists() && !file.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Returns the final .md output path for a given PDF path and optional output directory.
 */
export function buildOutputPath(
  pdfPath: string,
  outputDirectory: string,
): string {
  const basename = PathUtils.filename(pdfPath).replace(/\.pdf$/i, ".md");
  if (outputDirectory) {
    return PathUtils.join(outputDirectory, basename);
  }
  return PathUtils.join(PathUtils.parent(pdfPath)!, basename);
}

/**
 * Spawns an external process asynchronously.
 * Resolves on exit code 0, rejects otherwise.
 */
async function spawnProcess(bin: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // @ts-expect-error XPCOM class not fully typed in zotero-types
    const shellFile = Components.classes[
      "@mozilla.org/file/local;1"
    ].createInstance(Components.interfaces.nsIFile);
    try {
      shellFile.initWithPath(bin);
    } catch {
      reject(new Error(`Binary not found: ${bin}`));
      return;
    }
    // @ts-expect-error XPCOM class not fully typed in zotero-types
    const proc = Components.classes[
      "@mozilla.org/process/util;1"
    ].createInstance(Components.interfaces.nsIProcess);
    proc.init(shellFile);
    proc.runAsync(args, args.length, {
      observe(_subject: unknown, topic: string) {
        if (topic === "process-finished") {
          proc.exitValue === 0
            ? resolve()
            : reject(new Error(`Process exited with code ${proc.exitValue}`));
        } else if (topic === "process-failed") {
          reject(new Error("Process failed to start"));
        }
      },
    });
  });
}

/**
 * Builds the Python one-liner for the selected engine.
 * Both engines read a PDF and write a .md file directly.
 */
function buildPythonScript(
  engine: string,
  pdfPath: string,
  outputPath: string,
): string {
  // Escape single quotes in paths for shell safety
  const escapedPdf = pdfPath.replace(/'/g, "'\\''");
  const escapedOut = outputPath.replace(/'/g, "'\\''");

  if (engine === "pymupdf4llm") {
    return `import pymupdf4llm; md = pymupdf4llm.to_markdown('${escapedPdf}'); open('${escapedOut}', 'w').write(md)`;
  }

  // Default: docling
  return (
    `from docling.document_converter import DocumentConverter; ` +
    `r = DocumentConverter().convert('${escapedPdf}'); ` +
    `open('${escapedOut}', 'w').write(r.document.export_to_markdown())`
  );
}

/**
 * Runs the conversion using the selected engine via Python.
 */
export async function runConversion(
  pythonPath: string,
  engine: string,
  pdfPath: string,
  outputPath: string,
): Promise<void> {
  const script = buildPythonScript(engine, pdfPath, outputPath);
  const cmd = `${pythonPath} -c '${script.replace(/'/g, "'\\''")}'`;

  ztoolkit.log(`[AutoMD] Running ${engine} conversion: ${pdfPath}`);

  await spawnProcess("/bin/sh", ["-c", cmd]);

  // Verify output was created
  if (!fileExists(outputPath)) {
    throw new Error(
      `${engine} completed but output file not found at: ${outputPath}`,
    );
  }

  ztoolkit.log(`[AutoMD] Conversion complete: ${outputPath}`);
}

/**
 * High-level entry point: converts a Zotero PDF attachment item.
 * Waits up to 30 s for the file to become available (handles in-progress downloads).
 * Returns the final .md path on success.
 */
export async function convertAttachment(item: Zotero.Item): Promise<string> {
  // Poll until file is available (Zotero may still be downloading)
  let pdfPath: string | false = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    pdfPath = await item.getFilePathAsync();
    if (pdfPath) break;
    await new Promise<void>((r) => setTimeout(r, 5000));
  }
  if (!pdfPath) {
    throw new Error(
      `File not available after 30 s for attachment item ${item.id}`,
    );
  }

  const pythonPath = getPref("pythonPath") || detectPython();
  if (!pythonPath) {
    throw new Error("python3 not found. Set the Python path in AutoMD settings.");
  }

  const engine = getPref("converterEngine") || "docling";
  const outputDir = getPref("outputDirectory") || "";
  const outputPath = buildOutputPath(pdfPath, outputDir);

  await runConversion(pythonPath, engine, pdfPath, outputPath);
  return outputPath;
}
