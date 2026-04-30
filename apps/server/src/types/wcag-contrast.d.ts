declare module 'wcag-contrast' {
  export function hex(a: string, b: string): number;
  export function score(ratio: number): 'Fail' | 'AA Large' | 'AA' | 'AAA';
}
