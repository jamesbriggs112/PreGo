// The software Prego can recognise from what a visitor's browser receives (response headers and the
// generator meta tag), and where each one's vulnerability and end-of-life data comes from.

export interface Software {
  id: string;
  name: string;
  /** NVD CPE vendor:product pairs. */
  nvd?: string[];
  /** OSV package, for software that publishes advisories there. */
  osv?: { ecosystem: string; name: string };
  /** endoflife.date product. */
  eol?: string;
}

export const SOFTWARE: Software[] = [
  { id: 'wordpress', name: 'WordPress', nvd: ['wordpress:wordpress'], eol: 'wordpress' },
  { id: 'drupal', name: 'Drupal', osv: { ecosystem: 'Packagist', name: 'drupal/core' }, eol: 'drupal' },
  { id: 'joomla', name: 'Joomla', osv: { ecosystem: 'Packagist', name: 'joomla/joomla-cms' }, eol: 'joomla' },
  { id: 'apache', name: 'Apache HTTP Server', nvd: ['apache:http_server'], eol: 'apache-http-server' },
  { id: 'nginx', name: 'nginx', nvd: ['f5:nginx', 'nginx:nginx'], eol: 'nginx' },
  { id: 'php', name: 'PHP', nvd: ['php:php'], eol: 'php' },
  { id: 'openssl', name: 'OpenSSL', nvd: ['openssl:openssl'], eol: 'openssl' },
];

/** Retire.js component names whose npm package has another name. */
export const NPM_NAMES: Record<string, string> = {
  angularjs: 'angular',
  'jquery-ui-dialog': 'jquery-ui',
  'jquery-ui-autocomplete': 'jquery-ui',
  'jquery-ui-tooltip': 'jquery-ui',
  ember: 'ember-source',
  'moment.js': 'moment',
  DOMPurify: 'dompurify',
  'vue.js': 'vue',
  'react-dom': 'react-dom',
};

export const npmName = (component: string) => NPM_NAMES[component] ?? component.toLowerCase();

/** JavaScript libraries with end-of-life dates on endoflife.date, by Retire.js component name. */
export const JS_EOL: Record<string, string> = { jquery: 'jquery', angularjs: 'angularjs', bootstrap: 'bootstrap', vue: 'vue' };

/** Product tokens in Server and X-Powered-By headers, with their software ID. */
const HEADER_TOKENS: { pattern: RegExp; id: string }[] = [
  { pattern: /\bApache\/(\d+(?:\.\d+){1,3})/i, id: 'apache' },
  { pattern: /\bnginx\/(\d+(?:\.\d+){1,3})/i, id: 'nginx' },
  { pattern: /\bPHP\/(\d+(?:\.\d+){1,3})/i, id: 'php' },
  { pattern: /\bOpenSSL\/(\d+(?:\.\d+){1,3}[a-z]?)/i, id: 'openssl' },
];
const GENERATOR_TOKENS: { pattern: RegExp; id: string }[] = [
  { pattern: /\bWordPress\s+(\d+(?:\.\d+){1,3})/i, id: 'wordpress' },
  { pattern: /\bDrupal\s+(\d+(?:\.\d+){0,3})/i, id: 'drupal' },
  { pattern: /\bJoomla!?\s*(?:-\s*Open Source Content Management\s*)?(?:Version\s*)?(\d+(?:\.\d+){1,3})/i, id: 'joomla' },
];
/** Header text that says the software comes from a Linux distribution, which often backports fixes. */
const DISTRO = /\b(Ubuntu|Debian|CentOS|Red ?Hat|RHEL|Fedora|SUSE|Amazon Linux|AlmaLinux|Rocky|el\d|deb\d+u?\d*)\b/i;

export interface DetectedSoftware {
  id: string;
  name: string;
  version: string;
  /** Where the version came from, e.g. "Server header: Apache/2.4.49 (Unix)". */
  evidence: string;
  /** Packaged by a Linux distribution, which may have fixed vulnerabilities without changing the version. */
  distro: boolean;
}

/** Software and versions named in response headers and the generator meta tag. */
export function detectSoftware(headers: Record<string, string>, generators: string[]): DetectedSoftware[] {
  const found = new Map<string, DetectedSoftware>();
  const add = (id: string, version: string, evidence: string, distro: boolean) => {
    const software = SOFTWARE.find((s) => s.id === id)!;
    if (!found.has(id)) found.set(id, { id, name: software.name, version, evidence, distro });
  };
  for (const header of ['server', 'x-powered-by']) {
    const value = headers[header];
    if (!value) continue;
    for (const { pattern, id } of HEADER_TOKENS) {
      const match = value.match(pattern);
      if (match) add(id, match[1], `${header === 'server' ? 'Server' : 'X-Powered-By'} header: ${value}`, DISTRO.test(value));
    }
  }
  for (const generator of [...generators, headers['x-generator'] ?? ''].filter(Boolean)) {
    for (const { pattern, id } of GENERATOR_TOKENS) {
      const match = generator.match(pattern);
      if (match) add(id, match[1], `Generator: ${generator}`, false);
    }
  }
  return [...found.values()];
}
