import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_PLACEHOLDER = '__KIDCONTROL_VERSION__';

export function injectVersion(html, version) {
  if (!html.includes(VERSION_PLACEHOLDER)) throw new Error('WebUI version placeholder is missing');
  return html.replaceAll(VERSION_PLACEHOLDER, version);
}

export function assertSourceMappedJavaScript(javascript, sourceMapText, fileName) {
  const sourceMapName = `${fileName}.map`;
  if (!javascript.trimEnd().endsWith(`//# sourceMappingURL=${sourceMapName}`)) {
    throw new Error(`${fileName} does not reference ${sourceMapName}`);
  }
  let sourceMap;
  try {
    sourceMap = JSON.parse(sourceMapText);
  } catch {
    throw new Error(`${sourceMapName} is not valid JSON`);
  }
  if (sourceMap.version !== 3 || sourceMap.file !== fileName) {
    throw new Error(`${sourceMapName} does not describe ${fileName}`);
  }
  if (!Array.isArray(sourceMap.sources) || sourceMap.sources.length === 0) {
    throw new Error(`${sourceMapName} has no sources`);
  }
  if (sourceMap.sources.some((source) => typeof source !== 'string' || source.length === 0)) {
    throw new Error(`${sourceMapName} has invalid source paths`);
  }
  if (!Array.isArray(sourceMap.sourcesContent)
      || sourceMap.sourcesContent.length !== sourceMap.sources.length
      || sourceMap.sourcesContent.some((source) => typeof source !== 'string')) {
    throw new Error(`${sourceMapName} has incomplete sourcesContent`);
  }
  if (typeof sourceMap.mappings !== 'string' || sourceMap.mappings.length === 0) {
    throw new Error(`${sourceMapName} has invalid mappings`);
  }
}

export async function assertSourceMappedDirectory(directory, root = true) {
  const directoryPath = directory instanceof URL ? fileURLToPath(directory) : directory;
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`${entry.name} is a symbolic link`);
    if (!entry.isFile() && !entry.isDirectory()) throw new Error(`${entry.name} is an unsupported filesystem entry`);
  }
  const fileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (root && entry.name === 'public') continue;
      await assertSourceMappedDirectory(join(directoryPath, entry.name), false);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const mapName = `${entry.name}.map`;
    if (!fileNames.has(mapName)) throw new Error(`${entry.name} has no source map`);
    assertSourceMappedJavaScript(
      await readFile(join(directoryPath, entry.name), 'utf8'),
      await readFile(join(directoryPath, mapName), 'utf8'),
      entry.name
    );
  }
  for (const fileName of fileNames) {
    if (fileName.endsWith('.js.map') && !fileNames.has(fileName.slice(0, -4))) {
      throw new Error(`${fileName} is an orphan source map`);
    }
  }
}
