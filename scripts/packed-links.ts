import { posix } from 'node:path';

/** Check file destinations against the tarball, not files left in the checkout. */
export function missingPackedLinks(
  file: string,
  markdown: string,
  files: ReadonlySet<string>,
): string[] {
  const visible: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    const sequence = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (
        sequence &&
        sequence.charAt(0) === fence.charAt(0) &&
        sequence.length >= fence.length &&
        line
          .slice((/^ {0,3}/u.exec(line)?.[0].length ?? 0) + sequence.length)
          .trim() === ''
      )
        fence = undefined;
      continue;
    }
    if (sequence) fence = sequence;
    else visible.push(line);
  }
  const text = visible
    .join('\n')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/`[^`]*`/gu, '');
  const links = [
    ...text.matchAll(/\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/gu),
    ...text.matchAll(/^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gmu),
  ];
  const missing: string[] = [];
  for (const match of links) {
    const target = match[1] ?? match[2] ?? '';
    if (
      !target ||
      target.startsWith('#') ||
      /^[a-z][a-z\d+.-]*:/iu.test(target)
    )
      continue;
    let path: string;
    try {
      path = decodeURIComponent(target.split(/[?#]/u)[0] ?? '');
    } catch {
      missing.push(target);
      continue;
    }
    const resolved = posix
      .normalize(posix.join(posix.dirname(file), path))
      .replace(/\/$/u, '');
    const directory = [...files].some((entry) =>
      entry.startsWith(resolved + '/'),
    );
    if (
      posix.isAbsolute(path) ||
      resolved === '..' ||
      resolved.startsWith('../') ||
      !(resolved === '.' || files.has(resolved) || directory)
    )
      missing.push(target);
  }
  return [...new Set(missing)];
}
