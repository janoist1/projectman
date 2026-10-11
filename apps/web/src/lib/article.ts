import { t } from '../i18n/t';

/**
 * The Hungarian definite article for a role's name: "az" before a vowel, "a" before anything else
 * ("a Projektmenedzser", "az Operátor"). A person's name takes none, so use this for roles only.
 */
export function withArticle(name: string): string {
  const first = name.trim().charAt(0).toLowerCase();
  return `${first && t('common.vowels').includes(first) ? 'az' : 'a'} ${name}`;
}
