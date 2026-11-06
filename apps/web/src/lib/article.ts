import { currentLanguage } from '../i18n/language';
import { t } from '../i18n/t';

/**
 * The Hungarian definite article for a role's name: "az" before a vowel, "a" before anything else
 * ("a Projektmenedzser", "az Operátor"). A person's name takes none, so use this for roles only.
 * English has no such article: the bare name stays.
 */
export function withArticle(name: string): string {
  if (currentLanguage() !== 'hu') return name;
  const first = name.trim().charAt(0).toLowerCase();
  return `${first && t('common.vowels').includes(first) ? 'az' : 'a'} ${name}`;
}
