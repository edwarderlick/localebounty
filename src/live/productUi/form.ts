import { addressesEqual, isEoaAddress, isZeroAddress } from "../format";
import { genRewardError, genToWei } from "../product/task";
import { DEFAULT_SOURCE_LOCALE, MAX_KEY, MAX_LOCALE, MAX_TEXT } from "./constants";

export type CreateForm = {
  sourceText: string;
  sourceLocale: string;
  targetLocale: string;
  stringKey: string;
  appContext: string;
  intendedMeaning: string;
  semanticCriteria: string;
  translator: string;
  rewardGen: string;
};

export function emptyCreateForm(): CreateForm {
  return {
    sourceText: "",
    sourceLocale: DEFAULT_SOURCE_LOCALE,
    targetLocale: "ES-ES",
    stringKey: "",
    appContext: "",
    intendedMeaning: "",
    semanticCriteria: "",
    translator: "",
    rewardGen: "",
  };
}

export function formFingerprint(form: CreateForm): string {
  return JSON.stringify({
    sourceText: form.sourceText,
    sourceLocale: form.sourceLocale.trim(),
    targetLocale: form.targetLocale.trim(),
    stringKey: form.stringKey.trim(),
    appContext: form.appContext,
    intendedMeaning: form.intendedMeaning,
    semanticCriteria: form.semanticCriteria,
    translator: form.translator.trim().toLowerCase(),
    rewardGen: form.rewardGen.trim(),
  });
}

function bound(name: string, value: string, max: number, allowEmpty = false): string | undefined {
  const text = value;
  if (!allowEmpty && !text.trim()) return `${name} is required.`;
  if (text.length > max) return `${name} is ${text.length} characters; max is ${max}.`;
  return undefined;
}

export function createFormErrors(form: CreateForm, funder?: string): string[] {
  const errors: string[] = [];
  const source = bound("Source text", form.sourceText, MAX_TEXT);
  if (source) errors.push(source);
  const sourceLocale = bound("Source locale", form.sourceLocale, MAX_LOCALE);
  if (sourceLocale) errors.push(sourceLocale);
  const targetLocale = bound("Target locale", form.targetLocale, MAX_LOCALE);
  if (targetLocale) errors.push(targetLocale);
  const key = bound("String key", form.stringKey, MAX_KEY);
  if (key) errors.push(key);
  const context = bound("Context", form.appContext, MAX_TEXT, true);
  if (context) errors.push(context);
  const meaning = bound("Intended meaning", form.intendedMeaning, MAX_TEXT);
  if (meaning) errors.push(meaning);
  const criteria = bound("Semantic criteria", form.semanticCriteria, MAX_TEXT);
  if (criteria) errors.push(criteria);
  const translator = form.translator.trim();
  if (!isEoaAddress(translator) || isZeroAddress(translator)) {
    errors.push("Named translator must be a 20-byte EOA (0x + 40 hex).");
  } else if (funder && addressesEqual(translator, funder)) {
    errors.push("Named translator must be a different EOA than the connected funder.");
  }
  const rewardErr = genRewardError(form.rewardGen) ?? (genToWei(form.rewardGen) == null ? "Enter a GEN reward greater than zero." : undefined);
  if (!form.rewardGen.trim()) errors.push("Enter a GEN reward greater than zero, with at most 18 fractional digits.");
  else if (rewardErr) errors.push(rewardErr);
  return errors;
}

export function expectedWalletSpendWei(rewardWei: bigint, feeDepositWei: bigint): bigint {
  return rewardWei + feeDepositWei;
}
