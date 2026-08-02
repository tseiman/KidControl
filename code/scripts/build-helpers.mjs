const VERSION_PLACEHOLDER = '__KIDCONTROL_VERSION__';

export function injectVersion(html, version) {
  if (!html.includes(VERSION_PLACEHOLDER)) throw new Error('WebUI version placeholder is missing');
  return html.replaceAll(VERSION_PLACEHOLDER, version);
}
