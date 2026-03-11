import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 根據價格動態決定顯示格式
 * 小數點後 3 個以上連續 0 → 下標格式
 * 例如 0.00001284 → { type: 'subscript', zeros: 4, sig: '1284' }
 */
export type FormattedPrice =
  | { type: 'normal'; value: string }
  | { type: 'subscript'; zeros: number; sig: string };

export function formatPrice(price: number): FormattedPrice {
  if (!price || price === 0) return { type: 'normal', value: '0' };
  if (price >= 1000) return { type: 'normal', value: price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) };
  if (price >= 1)    return { type: 'normal', value: price.toFixed(4) };
  if (price >= 0.01) return { type: 'normal', value: price.toFixed(5) };

  const str = price.toFixed(12).replace(/0+$/, '');
  const afterDot = str.split('.')[1] || '';
  let zeroCount = 0;
  for (let i = 0; i < afterDot.length; i++) {
    if (afterDot[i] === '0') zeroCount++;
    else break;
  }
  if (zeroCount >= 3) {
    const sig = afterDot.slice(zeroCount, zeroCount + 4);
    return { type: 'subscript', zeros: zeroCount, sig };
  }
  return { type: 'normal', value: price.toFixed(6) };
}

export function formatPriceString(price: number): string {
  const f = formatPrice(price);
  if (f.type === 'subscript') return `0.0[${f.zeros}]${f.sig}`;
  return f.value;
}

export function getDecimals(price: number): number {
  if (price >= 1000) return 2;
  if (price >= 1)    return 4;
  if (price >= 0.01) return 5;
  if (price >= 0.0001) return 6;
  return 8;
}
