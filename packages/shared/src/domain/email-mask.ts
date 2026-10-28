/**
 * An address shown to someone who does not own it yet (the invitation page, PM-670): the first letter
 * of the local part, the first letter of the domain and its last label. `janos.kiss@example.co.uk`
 * becomes `j***@e***.uk`; a domain of one label gives `j***@e***`. Never the whole address.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 1 || at === trimmed.length - 1) return '***';
  const local = trimmed.slice(0, at);
  const labels = trimmed.slice(at + 1).split('.');
  const first = Array.from(local)[0] ?? '';
  const domainFirst = Array.from(labels[0] ?? '')[0] ?? '';
  const tld = labels.length > 1 ? labels[labels.length - 1] : '';
  return `${first}***@${domainFirst}***${tld ? `.${tld}` : ''}`;
}
